import { useCallback, useEffect, useState } from 'react';
import './App.css';
import AnalyserTab from './components/AnalyserTab';
import MonitorTab from './components/MonitorTab';

function App() {
  const [activeTab, setActiveTab] = useState('monitor');
  
  // Shared monitoring state
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  
  // Shared data state - accessible by both tabs
  const [runData, setRunData] = useState({
    startTime: null,
    endTime: null,
    samples: [],
    processes: {},
    previousFaults: {}
  });
  
  // Action log for process termination
  const [actionLog, setActionLog] = useState([]);

  // Add to action log
  const logAction = useCallback((action, details) => {
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      details
    };
    console.log('[Action Log]', entry);
    setActionLog(prev => [...prev, entry]);
  }, []);

  // Update run data (called from MonitorTab)
  const updateRunData = useCallback((updater) => {
    if (typeof updater === 'function') {
      setRunData(prev => updater(prev));
    } else {
      setRunData(updater);
    }
  }, []);

  // Clear run data
  const handleClearRun = useCallback(() => {
    setRunData({
      startTime: null,
      endTime: null,
      samples: [],
      processes: {},
      previousFaults: {}
    });
    setActionLog([]);
  }, []);

  // Auto-start monitoring when app launches
  useEffect(() => {
    // Small delay to ensure everything is mounted
    const timer = setTimeout(() => {
      setIsMonitoring(true);
      setRunData(prev => ({
        ...prev,
        startTime: new Date().toISOString()
      }));
    }, 500);
    
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="App">
      <header className="app-header">
        <div className="app-title">
          <span className="title-icon">📊</span>
          <h1>Real-Time System Fault & Performance Analyser</h1>
        </div>
        <nav className="tab-nav">
          <button 
            className={`tab-btn ${activeTab === 'monitor' ? 'active' : ''}`}
            onClick={() => setActiveTab('monitor')}
          >
            <span className="tab-icon">📡</span>
            Monitor
            {isMonitoring && !isPaused && <span className="live-indicator">●</span>}
          </button>
          <button 
            className={`tab-btn ${activeTab === 'analyser' ? 'active' : ''}`}
            onClick={() => setActiveTab('analyser')}
          >
            <span className="tab-icon">🔬</span>
            Analyser
            {runData.samples.length > 0 && <span className="data-indicator">●</span>}
          </button>
        </nav>
      </header>
      
      <main className="app-content">
        {activeTab === 'monitor' && (
          <MonitorTab 
            isMonitoring={isMonitoring}
            setIsMonitoring={setIsMonitoring}
            isPaused={isPaused}
            setIsPaused={setIsPaused}
            runData={runData}
            updateRunData={updateRunData}
            onClearRun={handleClearRun}
          />
        )}
        {activeTab === 'analyser' && (
          <AnalyserTab 
            runData={runData}
            onClearRun={handleClearRun}
            isMonitoring={isMonitoring}
            logAction={logAction}
            actionLog={actionLog}
          />
        )}
      </main>
    </div>
  );
}

export default App;
