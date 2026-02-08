import { useCallback, useEffect, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import './DefaultMode.css';

const DefaultMode = () => {
  const [output, setOutput] = useState([]);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [interval, setInterval] = useState(1.0);
  const [samples, setSamples] = useState(0);
  const [processName, setProcessName] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [showSettings, setShowSettings] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(null);
  const [processList, setProcessList] = useState([]);
  const [executionCount, setExecutionCount] = useState(0);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const [errorType, setErrorType] = useState(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showGraph, setShowGraph] = useState(true);
  const [graphData, setGraphData] = useState([]);
  const [trendDirection, setTrendDirection] = useState('stable'); // 'increasing', 'decreasing', 'stable'
  const [wavePoints, setWavePoints] = useState([]); // Track wave peaks and troughs
  const [currentPhase, setCurrentPhase] = useState('motive'); // 'motive' or 'corrective'
  const [consecutiveErrors, setConsecutiveErrors] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const terminalRef = useRef(null);
  const intervalRef = useRef(null);
  const shouldExecuteImmediately = useRef(false);
  const MAX_EXECUTIONS = 1000; // Safety limit to prevent infinite execution
  const MAX_CONSECUTIVE_ERRORS = 5; // Stop after 5 consecutive errors
  const MIN_INTERVAL = 0.5; // Minimum 0.5 seconds to prevent system overload

  const API_URL = 'http://localhost:5000/api';

  const fetchProcesses = async () => {
    try {
      const response = await fetch(`${API_URL}/processes`);
      const data = await response.json();
      if (response.ok && data.processes) {
        setProcessList(data.processes);
      }
    } catch (err) {
      console.error('Failed to fetch processes:', err);
    }
  };

  const scrollToBottom = () => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  };

  const detectWavePoints = (data) => {
    if (data.length < 3) return [];
    
    const points = [];
    let waveCounter = 0;
    let correctiveCounter = 0;
    let lastWasPeak = null;
    
    for (let i = 1; i < data.length - 1; i++) {
      const prev = data[i - 1].faults;
      const curr = data[i].faults;
      const next = data[i + 1].faults;
      
      // Detect peak (local maximum)
      if (curr > prev && curr > next) {
        if (lastWasPeak === false || lastWasPeak === null) {
          waveCounter++;
          if (waveCounter <= 5) {
            points.push({ index: i, label: waveCounter.toString(), type: 'peak', phase: 'motive' });
            lastWasPeak = true;
          } else {
            const labels = ['A', 'B', 'C'];
            if (correctiveCounter < 3) {
              points.push({ index: i, label: labels[correctiveCounter], type: 'peak', phase: 'corrective' });
              correctiveCounter++;
            }
            lastWasPeak = true;
          }
        }
      }
      // Detect trough (local minimum)
      else if (curr < prev && curr < next) {
        if (lastWasPeak === true || lastWasPeak === null) {
          if (waveCounter < 5) {
            waveCounter++;
            points.push({ index: i, label: waveCounter.toString(), type: 'trough', phase: 'motive' });
          } else {
            const labels = ['A', 'B', 'C'];
            if (correctiveCounter < 3) {
              points.push({ index: i, label: labels[correctiveCounter], type: 'trough', phase: 'corrective' });
              correctiveCounter++;
            }
          }
          lastWasPeak = false;
        }
      }
    }
    
    return points;
  };

  const parseOutputForGraph = (text) => {
    // Extract major page faults from output
    const lines = text.split('\n');
    let majorFaults = 0;
    
    // Look for JSON output format with totals
    const jsonMatch = text.match(/"totals":{"major":(\d+)/);
    if (jsonMatch) {
      majorFaults = parseInt(jsonMatch[1]);
    } else {
      // Look for table format with Major column
      for (const line of lines) {
        // Match lines with PID followed by Major/Minor columns
        const match = line.match(/^\s*\d+\s+(\d+)\s+\d+/);
        if (match) {
          majorFaults += parseInt(match[1]);
        }
      }
    }
    
    return majorFaults;
  };

  const CustomDot = (props) => {
    const { cx, cy, index } = props;
    const wavePoint = wavePoints.find(w => w.index === index);
    
    if (wavePoint) {
      const isPeak = wavePoint.type === 'peak';
      const isCorrectivePhase = wavePoint.phase === 'corrective';
      
      return (
        <g>
          <circle 
            cx={cx} 
            cy={cy} 
            r={8} 
            fill={isCorrectivePhase ? '#ff7b72' : '#58a6ff'}
            stroke="#0d1117"
            strokeWidth={2}
          />
          <text
            x={cx}
            y={isPeak ? cy - 15 : cy + 20}
            textAnchor="middle"
            fill={isCorrectivePhase ? '#ff7b72' : '#58a6ff'}
            fontSize="14"
            fontWeight="bold"
          >
            {wavePoint.label}
          </text>
        </g>
      );
    }
    
    return (
      <circle 
        cx={cx} 
        cy={cy} 
        r={4} 
        fill="#58a6ff"
        opacity={0.6}
      />
    );
  };

  const highlightOutput = (text) => {
    if (!text) return '';
    
    return text
      // Highlight headers (lines with ===== or -----)
      .replace(/(={10,}|\-{10,})/g, '<span class="hl-separator">$1</span>')
      // Highlight column headers
      .replace(/\b(PID|PPID|Process|Command|Faults\/s|Minor|Major|Total|ELAPSED|TIME|USER|%CPU|%MEM|VSZ|RSS|TTY|STAT|START|COMMAND)\b/g, '<span class="hl-header">$1</span>')
      // Highlight numbers (including decimals and percentages)
      .replace(/\b(\d+\.\d+|\d+)(%)?\b/g, '<span class="hl-number">$1$2</span>')
      // Highlight process IDs at line start
      .replace(/^(\d+)/gm, '<span class="hl-pid">$1</span>')
      // Highlight time stamps
      .replace(/\b(\d{1,2}:\d{2}(:\d{2})?)\b/g, '<span class="hl-time">$1</span>')
      // Highlight warnings/errors
      .replace(/\b(Error|WARNING|CRITICAL|Failed)\b/gi, '<span class="hl-error">$&</span>')
      // Highlight success messages
      .replace(/\b(Success|OK|Running|Active)\b/gi, '<span class="hl-success">$&</span>');
  };

  const executeCommand = useCallback(async () => {
    // Check if paused before executing
    if (isPaused) {
      return;
    }
    
    try {
      setIsLoading(true);
      setError(null);
      const processParam = processName ? `&process=${encodeURIComponent(processName)}` : '';
      const showAllParam = showAll ? '&showAll=true' : '';
      const response = await fetch(`${API_URL}/raw-output?interval=${interval}&samples=${samples}${processParam}${showAllParam}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch output');
      }

      setIsConnected(true);
      setOutput(prev => [...prev, data.output]);
      setExecutionCount(prev => prev + 1);
      setConsecutiveErrors(0); // Reset error counter on success
      const now = new Date();
      setLastUpdate(now);
      
      // Update graph data with major faults
      const majorFaults = parseOutputForGraph(data.output);
      
      setGraphData(prev => {
        const newData = [...prev, {
          time: now.toLocaleTimeString(),
          faults: majorFaults
        }];
        
        // Calculate trend direction
        if (prev.length > 0) {
          const lastValue = prev[prev.length - 1].faults;
          const change = majorFaults - lastValue;
          const changePercent = lastValue > 0 ? (change / lastValue) * 100 : 0;
          
          if (Math.abs(changePercent) < 5) {
            setTrendDirection('stable');
          } else if (change > 0) {
            setTrendDirection('increasing');
          } else {
            setTrendDirection('decreasing');
          }
        }
        
        // Keep only last 20 data points for performance
        const limitedData = newData.slice(-20);
        
        // Detect wave points and update phase
        const waves = detectWavePoints(limitedData);
        setWavePoints(waves);
        
        if (waves.length > 0) {
          const lastWave = waves[waves.length - 1];
          setCurrentPhase(lastWave.phase);
        }
        
        return limitedData;
      });
      
      setTimeout(scrollToBottom, 50);

    } catch (err) {
      setIsConnected(false);
      const errType = getErrorType(err.message);
      setError(err.message);
      setErrorType(errType);
      setOutput(prev => [...prev, `Error: ${err.message}\n`]);
      
      // Track consecutive errors and stop if too many
      setConsecutiveErrors(prev => {
        const newCount = prev + 1;
        if (newCount >= MAX_CONSECUTIVE_ERRORS) {
          setAutoRefresh(false);
          setOutput(current => [...current, `\n⚠️ Auto-refresh stopped: Too many consecutive errors (${MAX_CONSECUTIVE_ERRORS}). Please check the backend server.\n`]);
        }
        return newCount;
      });
    } finally {
      setIsLoading(false);
    }
  }, [processName, showAll, interval, samples, MAX_CONSECUTIVE_ERRORS, isPaused]);

  const clearTerminal = () => {
    setOutput([]);
    setError(null);
    setErrorType(null);
    setExecutionCount(0);
    setConsecutiveErrors(0);
    setLastUpdate(null);
    setGraphData([]);
    setWavePoints([]);
    setTrendDirection('stable');
    setCurrentPhase('motive');
  };

  const copyToClipboard = async () => {
    try {
      const text = output.join('');
      await navigator.clipboard.writeText(text);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const getErrorType = (errorMessage) => {
    if (errorMessage.toLowerCase().includes('network') || 
        errorMessage.toLowerCase().includes('fetch')) {
      return 'network';
    } else if (errorMessage.toLowerCase().includes('not found') || 
               errorMessage.toLowerCase().includes('executable')) {
      return 'notfound';
    } else if (errorMessage.toLowerCase().includes('permission')) {
      return 'permission';
    } else if (errorMessage.toLowerCase().includes('timeout')) {
      return 'timeout';
    }
    return 'general';
  };

  const getErrorSuggestion = (type) => {
    switch(type) {
      case 'network':
        return 'Make sure the backend server is running on port 5000. Try: cd backend && npm start';
      case 'notfound':
        return 'The PageFaultStat executable might not be built. Run "make" in the project root.';
      case 'permission':
        return 'You may need elevated permissions. Try running the backend with administrator privileges.';
      case 'timeout':
        return 'The operation took too long. Try increasing the interval or reducing the sample count.';
      default:
        return 'Check the console for more details or try refreshing the page.';
    }
  };

  const exportAs = (format) => {
    const text = output.join('');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    let content, filename, mimeType;

    switch(format) {
      case 'txt':
        content = text;
        filename = `pagefaultstat-${timestamp}.txt`;
        mimeType = 'text/plain';
        break;
      
      case 'json':
        const jsonData = {
          timestamp: new Date().toISOString(),
          interval: interval,
          samples: samples,
          processFilter: processName || null,
          showAll: showAll,
          executionCount: executionCount,
          output: text,
          metadata: {
            outputSize: text.length,
            lastUpdate: lastUpdate ? lastUpdate.toISOString() : null
          }
        };
        content = JSON.stringify(jsonData, null, 2);
        filename = `pagefaultstat-${timestamp}.json`;
        mimeType = 'application/json';
        break;
      
      case 'csv':
        // Parse output into CSV (basic implementation)
        const lines = text.split('\n').filter(line => line.trim());
        const csvLines = lines.map(line => {
          // Simple CSV: quote fields that contain commas or spaces
          const fields = line.split(/\s+/);
          return fields.map(f => f.includes(',') || f.includes(' ') ? `"${f}"` : f).join(',');
        });
        content = csvLines.join('\n');
        filename = `pagefaultstat-${timestamp}.csv`;
        mimeType = 'text/csv';
        break;
      
      default:
        return;
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    setShowExportMenu(false);
  };

  const toggleAutoRefresh = () => {
    const newState = !autoRefresh;
    setAutoRefresh(newState);
    setIsPaused(!newState); // Set paused state opposite of autoRefresh
    
    // When pausing, immediately clear the interval
    if (!newState && intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    
    // When resuming, mark that we should execute immediately
    if (newState) {
      shouldExecuteImmediately.current = true;
    }
  };

  const startMonitoring = () => {
    setShowSettings(false);
    clearTerminal();
    setIsPaused(false);
    shouldExecuteImmediately.current = true;
    setAutoRefresh(true);
  };

  useEffect(() => {
    // Prevent infinite execution - stop after samples count if specified
    if (autoRefresh && !showSettings) {
      // SAFETY CHECK 4: Enforce minimum interval to prevent rapid requests
      const safeInterval = Math.max(interval, MIN_INTERVAL);
      if (interval < MIN_INTERVAL) {
        setOutput(prev => [...prev, `\n⚠️ Interval adjusted from ${interval}s to ${MIN_INTERVAL}s to prevent system overload.\n`]);
      }
      
      // Clear any existing interval before creating a new one
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      
      // Execute immediately on start/resume if flagged
      if (shouldExecuteImmediately.current) {
        executeCommand();
        shouldExecuteImmediately.current = false;
      }
      
      // Set up interval for executions
      const timerId = setInterval(() => {
        executeCommand();
      }, safeInterval * 1000); // Use safe interval
      
      intervalRef.current = timerId;
    } else {
      // When paused or settings shown, clear the interval
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, showSettings, interval, executeCommand]);

  useEffect(() => {
    fetchProcesses();
  }, []);
  
  // Separate useEffect to monitor safety limits
  useEffect(() => {
    if (!autoRefresh) return;

    // Check if we've reached the sample limit
    if (samples > 0 && executionCount >= samples) {
      setAutoRefresh(false);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setOutput(prev => [...prev, `\n✓ Monitoring completed: ${samples} samples collected.\n`]);
      return;
    }
    
    // Absolute maximum execution limit
    if (executionCount >= MAX_EXECUTIONS) {
      setAutoRefresh(false);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setOutput(prev => [...prev, `\n⚠️ Safety limit reached: Maximum ${MAX_EXECUTIONS} executions. Auto-refresh stopped to prevent system hang.\n`]);
      return;
    }
    
    // Too many consecutive errors
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      setAutoRefresh(false);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setOutput(prev => [...prev, `\n⚠️ Auto-refresh stopped: Too many consecutive errors (${MAX_CONSECUTIVE_ERRORS}).\n`]);
      return;
    }
  }, [executionCount, consecutiveErrors, samples, autoRefresh, MAX_EXECUTIONS, MAX_CONSECUTIVE_ERRORS]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (showExportMenu && !event.target.closest('.export-container')) {
        setShowExportMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showExportMenu]);

  return (
    <div className="terminal-container">
      <div className="terminal-header">
        <div className="terminal-title">
          <span className="terminal-icon">▶</span>
          PageFaultStat Monitor
        </div>
        <div className="terminal-buttons">
          {!showSettings && (
            <>
              <button 
                className={`btn btn-refresh ${autoRefresh ? 'active' : ''}`}
                onClick={toggleAutoRefresh}
              >
                {autoRefresh ? '⏸ Pause' : '▶ Resume'}
              </button>
              <button 
                className="btn btn-settings" 
                onClick={() => { setAutoRefresh(false); setShowSettings(true); }}
              >
                ⚙ Settings
              </button>
              <button 
                className={`btn btn-graph ${showGraph ? 'active' : ''}`}
                onClick={() => setShowGraph(!showGraph)}
                title="Toggle graph view"
              >
                📊 {showGraph ? 'Hide' : 'Show'} Graph
              </button>
            </>
          )}
          <button 
            className={`btn btn-copy ${copySuccess ? 'success' : ''}`}
            onClick={copyToClipboard}
            disabled={output.length === 0}
            title="Copy output to clipboard"
          >
            {copySuccess ? '✅ Copied!' : '📋 Copy'}
          </button>
          <div className="export-container">
            <button 
              className="btn btn-export" 
              onClick={() => setShowExportMenu(!showExportMenu)}
              disabled={output.length === 0}
              title="Export output"
            >
              📥 Export
            </button>
            {showExportMenu && (
              <div className="export-menu">
                <button className="export-option" onClick={() => exportAs('txt')}>
                  <span className="export-icon">📝</span>
                  <span>Text File (.txt)</span>
                </button>
                <button className="export-option" onClick={() => exportAs('json')}>
                  <span className="export-icon">{'{}'}</span>
                  <span>JSON (.json)</span>
                </button>
                <button className="export-option" onClick={() => exportAs('csv')}>
                  <span className="export-icon">🗂️</span>
                  <span>CSV (.csv)</span>
                </button>
              </div>
            )}
          </div>
          <button 
            className="btn btn-clear" 
            onClick={clearTerminal}
          >
            🗑 Clear
          </button>
        </div>
      </div>

      {showSettings ? (
        <div className="settings-panel">
          <div className="settings-content">
            <h2>Configuration</h2>
            <div className="setting-group">
              <label htmlFor="interval">
                Sample interval in seconds (≥ 1):
              </label>
              <input
                id="interval"
                type="number"
                min="1"
                step="0.1"
                value={interval}
                onChange={(e) => setInterval(parseFloat(e.target.value) || 1.0)}
                placeholder="1.0"
              />
              <span className="hint">Default: 1.0 second</span>
            </div>
            <div className="setting-group">
              <label htmlFor="samples">
                Number of samples (0 for continuous):
              </label>
              <input
                id="samples"
                type="number"
                min="0"
                value={samples}
                onChange={(e) => setSamples(parseInt(e.target.value) || 0)}
                placeholder="0"
              />
              <span className="hint">Default: 0 (continuous)</span>
            </div>
            <div className="setting-group">
              <label htmlFor="process">
                Process name (optional):
              </label>
              <div className="input-with-dropdown">
                <input
                  id="process"
                  type="text"
                  value={processName}
                  onChange={(e) => setProcessName(e.target.value)}
                  placeholder="e.g., firefox, chrome"
                  list="process-suggestions"
                  autoComplete="off"
                />
                <datalist id="process-suggestions">
                  {processList.map((proc, idx) => (
                    <option key={idx} value={proc} />
                  ))}
                </datalist>
                <button 
                  type="button"
                  className="refresh-btn"
                  onClick={fetchProcesses}
                  title="Refresh process list"
                >
                  🔄
                </button>
              </div>
              <span className="hint">
                {processList.length > 0 
                  ? `${processList.length} processes available - start typing to filter` 
                  : 'Click 🔄 to load running processes'}
              </span>
            </div>
            <div className="setting-group">
              <label htmlFor="showAll" style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                <input
                  id="showAll"
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                  style={{width: 'auto', margin: 0}}
                />
                Show all processes with accumulating faults (-a)
              </label>
              <span className="hint">Display all processes that are accumulating page faults</span>
            </div>
            <button className="btn btn-start" onClick={startMonitoring}>
              ▶ Start Monitoring
            </button>
          </div>
        </div>
      ) : (
        <div className="monitoring-layout">
          <div className="terminal-section">
            <div className="terminal-body" ref={terminalRef}>
              {isLoading && output.length === 0 && (
                <div className="loading-indicator">
                  <div className="spinner"></div>
                  <span>Initializing monitoring...</span>
                </div>
              )}
              <pre 
                className="output-text"
                dangerouslySetInnerHTML={{ __html: highlightOutput(output.join('')) }}
              />
              {error && (
                <div className={`error-box error-${errorType}`}>
                  <div className="error-header">
                    <span className="error-icon">⚠️</span>
                    <span className="error-title">Error Occurred</span>
                  </div>
                  <div className="error-message">{error}</div>
                  {errorType && (
                    <div className="error-suggestion">
                      <span className="suggestion-icon">💡</span>
                      <span>{getErrorSuggestion(errorType)}</span>
                    </div>
                  )}
                </div>
              )}
              {isLoading && output.length > 0 && (
                <div className="loading-inline">
                  <span className="pulse-dot"></span> Fetching data...
                </div>
              )}
            </div>
            <div className="terminal-footer">
              <div className="footer-info">
                {isLoading ? (
                  <span className="status-fetching">
                    <span className="pulse-dot"></span> Fetching data...
                  </span>
                ) : (
                  <>
                    <span className="info-item">
                      <span className="info-label">Executions:</span>
                      <span className="info-value">{executionCount}</span>
                    </span>
                    {lastUpdate && (
                      <span className="info-item">
                        <span className="info-label">Last Update:</span>
                        <span className="info-value">{lastUpdate.toLocaleTimeString()}</span>
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          
          <div className="graph-section">
            {showGraph && (
              <div className="graph-container">
                <div className="graph-header">
                  <h3>📈 Major Page Faults - Elliott Wave Pattern</h3>
                  <span className="graph-stats">
                    {graphData.length > 0 ? (
                      <>
                        {graphData[graphData.length - 1]?.faults} faults
                        <span style={{
                          marginLeft: '12px',
                          padding: '4px 8px',
                          borderRadius: '4px',
                          background: currentPhase === 'motive' ? '#1f6feb20' : '#da363320',
                          color: currentPhase === 'motive' ? '#58a6ff' : '#ff7b72',
                          fontSize: '12px',
                          fontWeight: 'bold'
                        }}>
                          {currentPhase === 'motive' ? '1-5 Motive' : 'A-C Corrective'}
                        </span>
                        {trendDirection === 'increasing' && <span style={{color: '#ff7b72', marginLeft: '8px'}}>↗</span>}
                        {trendDirection === 'decreasing' && <span style={{color: '#7ee787', marginLeft: '8px'}}>↘</span>}
                        {trendDirection === 'stable' && <span style={{color: '#58a6ff', marginLeft: '8px'}}>→</span>}
                      </>
                    ) : '0 faults'}
                  </span>
                </div>
                
                <div className="graph-content">
                  {graphData.length > 0 && (
                    <div className="chart-wrapper">
                      <ResponsiveContainer width="100%" height={280}>
                        <LineChart data={graphData} margin={{ top: 10, right: 10, left: 5, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
                          <XAxis 
                            dataKey="time" 
                            stroke="#8b949e"
                            tick={{ fill: '#8b949e', fontSize: 9 }}
                            angle={-45}
                            textAnchor="end"
                            height={50}
                          />
                          <YAxis 
                            stroke="#8b949e"
                            tick={{ fill: '#8b949e', fontSize: 10 }}
                            width={40}
                          />
                          <Tooltip 
                            contentStyle={{ 
                              backgroundColor: '#161b22', 
                              border: '1px solid #30363d',
                              borderRadius: '6px',
                              color: '#c9d1d9'
                            }}
                          />
                          <Line 
                            type="monotone" 
                            dataKey="faults" 
                            stroke="#58a6ff" 
                            strokeWidth={3}
                            dot={<CustomDot />}
                            activeDot={{ r: 10 }}
                            name="Major Faults"
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  
                  <div className="stats-grid">
                  <div className="stat-item">
                    <div className="stat-label">Current</div>
                    <div className="stat-value">
                      {graphData.length > 0 
                        ? `${graphData[graphData.length - 1]?.faults}`
                        : '0'
                      }
                    </div>
                    <div className="stat-unit">major faults</div>
                  </div>
                  
                  <div className="stat-item">
                    <div className="stat-label">Average</div>
                    <div className="stat-value">
                      {graphData.length > 0 
                        ? `${Math.round(graphData.reduce((acc, d) => acc + d.faults, 0) / graphData.length)}`
                        : '0'
                      }
                    </div>
                    <div className="stat-unit">major faults</div>
                  </div>
                  
                  <div className="stat-item">
                    <div className="stat-label">Peak</div>
                    <div className="stat-value">
                      {graphData.length > 0 
                        ? `${Math.max(...graphData.map(d => d.faults))}`
                        : '0'
                      }
                    </div>
                    <div className="stat-unit">major faults</div>
                  </div>
                  
                  <div className="stat-item">
                    <div className="stat-label">Points</div>
                    <div className="stat-value">{graphData.length}</div>
                    <div className="stat-unit">samples</div>
                  </div>
                  
                  <div className="stat-item">
                    <div className="stat-label">Interval</div>
                    <div className="stat-value">{interval}</div>
                    <div className="stat-unit">seconds</div>
                  </div>
                  
                  <div className="stat-item">
                    <div className="stat-label">Runs</div>
                    <div className="stat-value">{executionCount}</div>
                    <div className="stat-unit">total</div>
                  </div>
                </div>
              </div>
            
              <div className="graph-footer">
                {lastUpdate && (
                  <div className="last-update">
                    <span className="update-label">Last Update:</span>
                    <span className="update-time">{lastUpdate.toLocaleTimeString()}</span>
                  </div>
                )}
                
                {processName && (
                  <div className="active-filter-tag">
                    <span className="filter-icon">🔍</span>
                    <span>{processName}</span>
                  </div>
                )}
                
                {showAll && (
                  <div className="active-filter-tag">
                    <span className="filter-icon">✅</span>
                    <span>Show All</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    )}

      <div className="terminal-footer">
        <div className="status-bar">
          <span className="status-item status-primary">
            {autoRefresh ? '🔄 Running' : '⏸ Paused'}
          </span>
          {isConnected !== null && (
            <span className={`status-item connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
              <span className="status-dot"></span>
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          )}
          <span className="status-item">
            <span className="status-label">Interval:</span> {interval}s
          </span>
          <span className="status-item">
            <span className="status-label">Samples:</span> {samples === 0 ? 'Continuous' : samples}
          </span>
          {processName && (
            <span className="status-item status-filter">
              <span className="filter-icon">🔍</span> {processName}
            </span>
          )}
          {showAll && (
            <span className="status-item status-filter">
              <span className="filter-icon">✅</span> Show All
            </span>
          )}
          {executionCount > 0 && (
            <span className="status-item">
              <span className="status-label">Executions:</span> {executionCount}
            </span>
          )}
          {lastUpdate && (
            <span className="status-item">
              <span className="status-label">Last Update:</span> {lastUpdate.toLocaleTimeString()}
            </span>
          )}
          <span className="status-item">
            <span className="status-label">Size:</span> {(output.join('').length / 1024).toFixed(1)} KB
          </span>
        </div>
      </div>
    </div>
  );
};

export default DefaultMode;
