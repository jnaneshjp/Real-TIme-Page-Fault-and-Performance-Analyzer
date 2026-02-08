import { useCallback, useEffect, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import './MonitorTab.css';

const API_URL = 'http://localhost:5000/api';

const MonitorTab = ({ 
  isMonitoring, 
  setIsMonitoring, 
  isPaused, 
  setIsPaused, 
  runData, 
  updateRunData,
  onClearRun 
}) => {
  // Local state
  const [isConnected, setIsConnected] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  
  // Configuration
  const [interval, setIntervalValue] = useState(1.0);
  const [processName, setProcessName] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [processList, setProcessList] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportFilename, setExportFilename] = useState('fault-data');
  const [exportError, setExportError] = useState(null);
  
  // Data collection
  const [liveOutput, setLiveOutput] = useState([]);
  const [executionCount, setExecutionCount] = useState(0);
  const [lastUpdate, setLastUpdate] = useState(null);
  
  const terminalRef = useRef(null);
  const intervalRef = useRef(null);
  const shouldExecuteImmediately = useRef(true);
  
  const MIN_INTERVAL = 0.5;
  const MAX_CONSECUTIVE_ERRORS = 5;
  const consecutiveErrorsRef = useRef(0);

  // Fetch available processes
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

  // Scroll terminal to bottom
  const scrollToBottom = () => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  };

  // Parse output for process fault data
  const parseOutputData = (text) => {
    const parseMetric = (value) => {
      if (value === undefined || value === null) return 0;
      const trimmed = String(value).trim();
      if (!trimmed) return 0;

      const suffix = trimmed.slice(-1).toLowerCase();
      const base = parseFloat(trimmed);
      if (Number.isNaN(base)) return 0;

      const multipliers = { k: 1000, m: 1000000, g: 1000000000 };
      return multipliers[suffix] ? base * multipliers[suffix] : base;
    };

    const parseTextLine = (line) => {
      const cleanLine = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
      if (!cleanLine) return null;

      const multiPattern = /^\s*(\d+)\s+([-\d\.a-zA-Z]+)\s+([-\d\.a-zA-Z]+)\s+([-\d\.a-zA-Z]+)\s+([-\d\.a-zA-Z]+)\s+([-\d\.a-zA-Z]+)\s+(?:[v^]\s+)?(\S+)\s+(.+)$/;
      const singlePattern = /^\s*(\d+)\s+([-\d\.a-zA-Z]+)\s+([-\d\.a-zA-Z]+)\s+([-\d\.a-zA-Z]+)\s+(?:[v^]\s+)?(\S+)\s+(.+)$/;

      let match = cleanLine.match(multiPattern);
      if (match) {
        return {
          pid: parseInt(match[1], 10),
          major: parseMetric(match[2]),
          minor: parseMetric(match[3]),
          user: match[7],
          name: match[8]
        };
      }

      match = cleanLine.match(singlePattern);
      if (match) {
        return {
          pid: parseInt(match[1], 10),
          major: parseMetric(match[2]),
          minor: parseMetric(match[3]),
          user: match[5],
          name: match[6]
        };
      }

      return null;
    };

    const results = {
      timestamp: new Date().toISOString(),
      processes: [],
      totalMajor: 0,
      totalMinor: 0
    };

    // Try JSON format first
    const jsonMatch = text.match(/"totals":\s*\{[^}]+\}/);
    if (jsonMatch) {
      try {
        const jsonStr = text.match(/\{[\s\S]*"processes"[\s\S]*\}/);
        if (jsonStr) {
          const data = JSON.parse(jsonStr[0]);
          results.totalMajor = data.totals?.major || 0;
          results.totalMinor = data.totals?.minor || 0;
          
          if (data.processes) {
            results.processes = data.processes.map(p => ({
              pid: p.pid,
              name: p.command || p.name,
              user: p.user,
              major: p.major || 0,
              minor: p.minor || 0
            }));
          }
          return results;
        }
      } catch (e) {
        // Fall through to text parsing
      }
    }

    // Parse text format
    const lines = text.split('\n');
    for (const line of lines) {
      const parsed = parseTextLine(line);
      if (parsed) {
        results.processes.push({
          pid: parsed.pid,
          major: parsed.major,
          minor: parsed.minor,
          user: parsed.user,
          name: parsed.name
        });
        results.totalMajor += parsed.major;
        results.totalMinor += parsed.minor;
      }
    }

    return results;
  };

  // Execute monitoring command
  const executeCommand = useCallback(async () => {
    if (isPaused) return;

    try {
      setIsLoading(true);
      setError(null);
      
      const processParam = processName ? `&process=${encodeURIComponent(processName)}` : '';
      const showAllParam = showAll ? '&showAll=true' : '';
      const response = await fetch(
        `${API_URL}/raw-output?interval=${interval}&samples=1${processParam}${showAllParam}`
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch output');
      }

      setIsConnected(true);
      consecutiveErrorsRef.current = 0;
      
      // Parse the output data
      const parsedData = parseOutputData(data.output);
      const now = new Date();
      
      // Calculate per-interval faults and update runData
      updateRunData(prev => {
        const newSamples = [...prev.samples];
        const newProcesses = { ...prev.processes };
        const newPrevFaults = { ...prev.previousFaults };
        
        // Calculate delta for each process
        parsedData.processes.forEach(proc => {
          const key = `${proc.pid}-${proc.name}`;
          const prevMajor = newPrevFaults[key]?.major || 0;
          const deltaFaults = proc.major - prevMajor;
          
          // Store current as previous for next iteration
          newPrevFaults[key] = { major: proc.major, minor: proc.minor };
          
          // Update process tracking
          if (!newProcesses[key]) {
            newProcesses[key] = {
              pid: proc.pid,
              name: proc.name,
              user: proc.user || 'unknown',
              samples: [],
              totalMajor: 0,
              totalMinor: 0
            };
          } else if (proc.user && proc.user !== 'unknown' && newProcesses[key].user === 'unknown') {
            // Update user if we get it later
            newProcesses[key].user = proc.user;
          }
          
          // Only add positive delta
          const perIntervalFaults = Math.max(0, deltaFaults);
          newProcesses[key].samples.push({
            timestamp: now.toISOString(),
            majorFaults: perIntervalFaults,
            cumulativeMajor: proc.major
          });
          newProcesses[key].totalMajor = proc.major;
          newProcesses[key].totalMinor = proc.minor;
        });
        
        // Add to overall samples
        let totalDeltaMajor = 0;
        parsedData.processes.forEach(proc => {
          const key = `${proc.pid}-${proc.name}`;
          const lastSample = newProcesses[key]?.samples.slice(-1)[0];
          if (lastSample) {
            totalDeltaMajor += lastSample.majorFaults;
          }
        });
        
        newSamples.push({
          timestamp: now.toISOString(),
          time: now.toLocaleTimeString(),
          intervalIndex: newSamples.length + 1,
          majorFaults: totalDeltaMajor,
          totalMajor: parsedData.totalMajor,
          totalMinor: parsedData.totalMinor,
          processCount: parsedData.processes.length
        });
        
        return {
          ...prev,
          samples: newSamples,
          processes: newProcesses,
          previousFaults: newPrevFaults,
          endTime: now.toISOString()
        };
      });
      
      // Update live display
      setLiveOutput(prev => [...prev, data.output]);
      setExecutionCount(prev => prev + 1);
      setLastUpdate(now);
      
      setTimeout(scrollToBottom, 50);

    } catch (err) {
      setIsConnected(false);
      setError(err.message);
      consecutiveErrorsRef.current += 1;
      
      if (consecutiveErrorsRef.current >= MAX_CONSECUTIVE_ERRORS) {
        setIsMonitoring(false);
        setLiveOutput(prev => [...prev, `\n⚠️ Auto-refresh stopped: Too many consecutive errors.\n`]);
      }
    } finally {
      setIsLoading(false);
    }
  }, [processName, showAll, interval, isPaused, updateRunData, setIsMonitoring]);

  // Toggle pause/resume
  const togglePause = () => {
    setIsPaused(prev => {
      if (prev) {
        shouldExecuteImmediately.current = true;
      }
      return !prev;
    });
  };

  // Start new monitoring session
  const startNewSession = () => {
    onClearRun();
    updateRunData({
      startTime: new Date().toISOString(),
      endTime: null,
      samples: [],
      processes: {},
      previousFaults: {}
    });
    setLiveOutput([]);
    setExecutionCount(0);
    setError(null);
    consecutiveErrorsRef.current = 0;
    setIsPaused(false);
    shouldExecuteImmediately.current = true;
    setIsMonitoring(true);
  };

  // Stop monitoring
  const stopMonitoring = () => {
    setIsMonitoring(false);
    setIsPaused(false);
    
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    
    updateRunData(prev => ({
      ...prev,
      endTime: new Date().toISOString()
    }));
  };

  // Clear terminal
  const clearTerminal = () => {
    setLiveOutput([]);
    setError(null);
  };

  // Effect for monitoring interval
  useEffect(() => {
    if (isMonitoring && !isPaused && !showSettings) {
      const safeInterval = Math.max(interval, MIN_INTERVAL);
      
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      
      if (shouldExecuteImmediately.current) {
        executeCommand();
        shouldExecuteImmediately.current = false;
      }
      
      intervalRef.current = setInterval(() => {
        executeCommand();
      }, safeInterval * 1000);
    } else {
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
  }, [isMonitoring, isPaused, showSettings, interval, executeCommand]);

  // Fetch processes on mount
  useEffect(() => {
    fetchProcesses();
  }, []);

  // Calculate live statistics
  const liveStats = {
    samples: runData.samples.length,
    lastDeltaFaults: runData.samples.length > 0 
      ? runData.samples[runData.samples.length - 1].majorFaults 
      : 0,
    totalMajor: runData.samples.length > 0 
      ? runData.samples[runData.samples.length - 1].totalMajor 
      : 0,
    processCount: Object.keys(runData.processes).length,
    avgFaults: runData.samples.length > 0
      ? Math.round(runData.samples.reduce((a, s) => a + s.majorFaults, 0) / runData.samples.length)
      : 0,
    peakFaults: runData.samples.length > 0
      ? Math.max(...runData.samples.map(s => s.majorFaults))
      : 0
  };

  // Prepare graph data - show last 60 samples for readability
  const graphData = runData.samples.slice(-60).map((sample, idx) => ({
    ...sample,
    displayIndex: idx + 1
  }));

  // Highlight output text
  const highlightOutput = (text) => {
    if (!text) return '';
    
    return text
      .replace(/(={10,}|-{10,})/g, '<span class="hl-separator">$1</span>')
      .replace(/\b(PID|PPID|Process|Command|Minor|Major|Total|USER)\b/g, '<span class="hl-header">$1</span>')
      .replace(/\b(\d+\.?\d*)(%)?\b/g, '<span class="hl-number">$1$2</span>')
      .replace(/\b(Error|WARNING|CRITICAL|Failed)\b/gi, '<span class="hl-error">$&</span>')
      .replace(/\b(Success|OK|Running|Active)\b/gi, '<span class="hl-success">$&</span>');
  };

  const sanitizeFilename = (name) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return 'fault-data';
    const cleaned = trimmed.replace(/[^a-zA-Z0-9-_]/g, '_');
    return cleaned || 'fault-data';
  };

  const buildCsvContent = () => {
    if (!runData?.samples?.length) {
      throw new Error('No samples to export yet.');
    }

    const escapeVal = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const lines = [];

    lines.push(`Session Start,${escapeVal(runData.startTime || '-')}`);
    lines.push(`Session End,${escapeVal(runData.endTime || new Date().toISOString())}`);
    lines.push(`Interval (s),${escapeVal(interval)}`);
    lines.push(`Processes Seen,${escapeVal(Object.keys(runData.processes || {}).length)}`);
    lines.push('');
    lines.push([
      'Sample #',
      'Timestamp',
      'Time',
      'Major Faults',
      'Total Major',
      'Total Minor',
      'Process Count'
    ].map(escapeVal).join(','));

    runData.samples.forEach((sample, idx) => {
      lines.push([
        idx + 1,
        sample.timestamp || '',
        sample.time || '',
        sample.majorFaults ?? 0,
        sample.totalMajor ?? 0,
        sample.totalMinor ?? 0,
        sample.processCount ?? Object.keys(runData.processes || {}).length
      ].map(escapeVal).join(','));
    });

    return lines.join('\n');
  };

  const handleExport = () => {
    try {
      const safeName = sanitizeFilename(exportFilename);
      const csvContent = buildCsvContent();
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${safeName}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      setShowExportModal(false);
      setExportError(null);
    } catch (err) {
      setExportError(err.message || 'Failed to export data.');
    }
  };

  return (
    <div className="monitor-tab">
      {/* Settings Modal */}
      {showSettings && (
        <div className="settings-overlay">
          <div className="settings-modal">
            <div className="settings-header">
              <h2>🎛️ Monitoring Settings</h2>
              <button className="close-btn" onClick={() => setShowSettings(false)}>✕</button>
            </div>
            
            <div className="settings-grid">
              <div className="setting-group">
                <label htmlFor="interval">
                  <span className="setting-icon">⏱️</span>
                  Sampling Interval
                </label>
                <div className="input-wrapper">
                  <input
                    id="interval"
                    type="number"
                    min="0.5"
                    step="0.1"
                    value={interval}
                    onChange={(e) => setIntervalValue(parseFloat(e.target.value) || 1.0)}
                  />
                  <span className="input-suffix">seconds</span>
                </div>
                <span className="hint">Minimum: 0.5 seconds</span>
              </div>
              
              <div className="setting-group full-width">
                <label htmlFor="process">
                  <span className="setting-icon">🔍</span>
                  Process Filter (optional)
                </label>
                <div className="input-with-button">
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
              </div>
              
              <div className="setting-group checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={showAll}
                    onChange={(e) => setShowAll(e.target.checked)}
                  />
                  <span className="checkbox-custom"></span>
                  <span>Show all processes with accumulating faults</span>
                </label>
              </div>
            </div>
            
            <div className="settings-actions">
              <button className="btn btn-primary" onClick={() => setShowSettings(false)}>
                Apply Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {showExportModal && (
        <div className="settings-overlay">
          <div className="export-modal">
            <div className="settings-header">
              <h2>⬇️ Export Data</h2>
              <button className="close-btn" onClick={() => setShowExportModal(false)}>✕</button>
            </div>
            <div className="setting-group">
              <label htmlFor="export-filename">
                <span className="setting-icon">💾</span>
                File name
              </label>
              <div className="input-wrapper">
                <input
                  id="export-filename"
                  type="text"
                  value={exportFilename}
                  onChange={(e) => setExportFilename(e.target.value)}
                  placeholder="fault-data"
                  autoComplete="off"
                />
                <span className="input-suffix">.csv</span>
              </div>
              <span className="export-tip">Exports current samples: timestamp, faults, totals, process count.</span>
              {exportError && <div className="export-error">{exportError}</div>}
            </div>
            <div className="settings-actions">
              <button className="btn btn-secondary" onClick={() => setShowExportModal(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleExport}>
                Export CSV
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Monitoring View */}
      <div className="monitoring-view">
        <div className="monitoring-header">
          <div className="monitoring-controls">
            {isMonitoring ? (
              <>
                <button 
                  className={`btn ${isPaused ? 'btn-success' : 'btn-warning'}`}
                  onClick={togglePause}
                >
                  {isPaused ? '▶ Resume' : '⏸ Pause'}
                </button>
                <button 
                  className="btn btn-danger"
                  onClick={stopMonitoring}
                >
                  ⏹ Stop
                </button>
              </>
            ) : (
              <button 
                className="btn btn-primary"
                onClick={startNewSession}
              >
                ▶ Start New Session
              </button>
            )}
            <button 
              className="btn btn-secondary"
              onClick={() => setShowSettings(true)}
            >
              ⚙️ Settings
            </button>
            <button 
              className="btn btn-secondary"
              onClick={() => {
                setExportError(null);
                setShowExportModal(true);
              }}
            >
              ⬇️ Export Data
            </button>
            <button 
              className="btn btn-secondary"
              onClick={clearTerminal}
            >
              🗑️ Clear Log
            </button>
          </div>
          
          <div className="monitoring-status">
            <span className={`status-badge ${isMonitoring ? (isPaused ? 'paused' : 'running') : 'stopped'}`}>
              <span className="status-dot"></span>
              {isMonitoring ? (isPaused ? 'Paused' : 'Monitoring') : 'Stopped'}
            </span>
            {isConnected !== null && (
              <span className={`status-badge ${isConnected ? 'connected' : 'disconnected'}`}>
                <span className="status-dot"></span>
                {isConnected ? 'Connected' : 'Disconnected'}
              </span>
            )}
          </div>
        </div>

        <div className="monitoring-content">
          {/* Left Side - Stats and Terminal */}
          <div className="left-panel">
            {/* Live Stats Cards */}
            <div className="live-stats-cards">
              <div className="stat-card primary">
                <div className="stat-icon">📊</div>
                <div className="stat-content">
                  <div className="stat-value">{liveStats.samples}</div>
                  <div className="stat-label">Samples</div>
                </div>
              </div>
              <div className="stat-card highlight">
                <div className="stat-icon">⚡</div>
                <div className="stat-content">
                  <div className="stat-value">{liveStats.lastDeltaFaults}</div>
                  <div className="stat-label">Last Δ Faults</div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">📈</div>
                <div className="stat-content">
                  <div className="stat-value">{liveStats.avgFaults}</div>
                  <div className="stat-label">Avg Faults</div>
                </div>
              </div>
              <div className="stat-card warning">
                <div className="stat-icon">🔺</div>
                <div className="stat-content">
                  <div className="stat-value">{liveStats.peakFaults}</div>
                  <div className="stat-label">Peak Faults</div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">🔢</div>
                <div className="stat-content">
                  <div className="stat-value">{liveStats.totalMajor}</div>
                  <div className="stat-label">Total Major</div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon">⚙️</div>
                <div className="stat-content">
                  <div className="stat-value">{liveStats.processCount}</div>
                  <div className="stat-label">Processes</div>
                </div>
              </div>
            </div>

            {/* Terminal Output */}
            <div className="terminal-panel">
              <div className="terminal-title-bar">
                <span>📡 Live Output</span>
                <span className="terminal-stats">
                  {lastUpdate && `Last: ${lastUpdate.toLocaleTimeString()}`}
                </span>
              </div>
              <div className="terminal-body" ref={terminalRef}>
                {isLoading && liveOutput.length === 0 && (
                  <div className="loading-indicator">
                    <div className="spinner"></div>
                    <span>Initializing monitoring...</span>
                  </div>
                )}
                <pre 
                  className="output-text"
                  dangerouslySetInnerHTML={{ __html: highlightOutput(liveOutput.join('')) }}
                />
                {error && (
                  <div className="error-box">
                    <div className="error-header">
                      <span className="error-icon">⚠️</span>
                      <span className="error-title">Error</span>
                    </div>
                    <div className="error-message">{error}</div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Side - Live Graph */}
          <div className="graph-panel">
            <div className="graph-header">
              <h3>📈 Major Page Faults per Interval</h3>
              <span className="graph-subtitle">Live updating • Last 60 samples</span>
            </div>
            <div className="graph-container">
              {graphData.length > 0 ? (
                <ResponsiveContainer width="100%" height={350}>
                  <LineChart data={graphData} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
                    <XAxis 
                      dataKey="time" 
                      stroke="#8b949e"
                      tick={{ fill: '#8b949e', fontSize: 10 }}
                      angle={-45}
                      textAnchor="end"
                      height={60}
                      interval="preserveStartEnd"
                    />
                    <YAxis 
                      stroke="#8b949e"
                      tick={{ fill: '#8b949e', fontSize: 11 }}
                      label={{ 
                        value: 'Major Faults', 
                        angle: -90, 
                        position: 'insideLeft',
                        fill: '#8b949e',
                        fontSize: 12
                      }}
                    />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: '#161b22', 
                        border: '1px solid #30363d',
                        borderRadius: '8px',
                        color: '#c9d1d9'
                      }}
                      formatter={(value) => [value, 'Major Faults/Interval']}
                      labelFormatter={(label) => `Time: ${label}`}
                    />
                    {/* Average line */}
                    <ReferenceLine 
                      y={liveStats.avgFaults} 
                      stroke="#d29922" 
                      strokeDasharray="5 5"
                      label={{ value: 'Avg', position: 'right', fill: '#d29922', fontSize: 10 }}
                    />
                    <Line 
                      type="monotone" 
                      dataKey="majorFaults" 
                      stroke="#58a6ff" 
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 6, fill: '#58a6ff' }}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="graph-placeholder">
                  <div className="placeholder-icon">📊</div>
                  <p>Waiting for data...</p>
                  <span>Graph will appear once monitoring begins</span>
                </div>
              )}
            </div>
            
            {/* Session Info */}
            <div className="session-info">
              <div className="info-row">
                <span className="info-label">Session Started:</span>
                <span className="info-value">
                  {runData.startTime ? new Date(runData.startTime).toLocaleTimeString() : '-'}
                </span>
              </div>
              <div className="info-row">
                <span className="info-label">Duration:</span>
                <span className="info-value">
                  {runData.startTime 
                    ? `${Math.round((new Date() - new Date(runData.startTime)) / 1000)}s`
                    : '-'}
                </span>
              </div>
              <div className="info-row">
                <span className="info-label">Interval:</span>
                <span className="info-value">{interval}s</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MonitorTab;
