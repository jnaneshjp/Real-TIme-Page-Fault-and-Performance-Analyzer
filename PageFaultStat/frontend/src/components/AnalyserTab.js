import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import './AnalyserTab.css';

const API_URL = 'http://localhost:5000/api';

// Protected process patterns - processes that should NOT be terminated
const PROTECTED_PROCESSES = [
  'init', 'systemd', 'kthreadd', 'ksoftirqd', 'kworker', 'migration',
  'watchdog', 'cpuhp', 'netns', 'rcu_sched', 'rcu_bh', 'rcu_preempt',
  'kdevtmpfs', 'mm_percpu_wq', 'ksmd', 'khugepaged', 'kintegrityd',
  'kblockd', 'blkcg_punt_bio', 'tpm_dev_wq', 'ata_sff', 'scsi_eh',
  'scsi_tmf_', 'dm_bufio_cache', 'kdmflush', 'kswapd', 'ecryptfs', 
  'kthrotld', 'irq/', 'acpi_thermal_pm', 'hwrng', 'mld', 'ipv6_addrconf', 
  'zswap', 'kcompactd', 'kauditd', 'oom_reaper', 'writeback', 'md', 
  'raid', 'loop', 'nbd', 'drbd', 'jbd2', 'ext4', 'crypto', 'iscsi', 
  'xfs', 'btrfs', 'cgroup', 'perf', 'khungtaskd', 'node', 'npm', 
  'PageFaultStat', 'faultstat'
];

const PROTECTED_USERS = ['root', 'system', 'kernel'];

const AnalyserTab = ({ 
  runData, 
  onClearRun, 
  isMonitoring,
  logAction,
  actionLog 
}) => {
  const [sortBy, setSortBy] = useState('totalMajor');
  const [sortOrder, setSortOrder] = useState('desc');
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [terminatingPid, setTerminatingPid] = useState(null);
  const [terminatedPids, setTerminatedPids] = useState(new Set());
  const [terminationError, setTerminationError] = useState(null);
  const [terminationSuccess, setTerminationSuccess] = useState(null);
  const [processFilter, setProcessFilter] = useState('');
  const [hideTerminated, setHideTerminated] = useState(true);
  const [processUsers, setProcessUsers] = useState({});
  const fetchUsersPending = useRef(false);
  const processUsersRef = useRef(processUsers);
  
  // Reason Modal state
  const [showReasonModal, setShowReasonModal] = useState(false);
  const [reasonData, setReasonData] = useState(null);
  const [reasonLoading, setReasonLoading] = useState(false);
  const [reasonError, setReasonError] = useState(null);
  
  // Threshold for triggering fault reasoning (1000 major page faults)
  const FAULT_THRESHOLD = 1000;
  
  // Process liveness tracking for safe termination
  const [processLiveness, setProcessLiveness] = useState({});
  const validationPending = useRef(false);
  
  // Keep ref in sync with state
  useEffect(() => {
    processUsersRef.current = processUsers;
  }, [processUsers]);

  // Auto-clear success/error messages after 5 seconds
  useEffect(() => {
    if (terminationSuccess || terminationError) {
      const timer = setTimeout(() => {
        setTerminationSuccess(null);
        setTerminationError(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [terminationSuccess, terminationError]);

  // Get processes from current session that have page faults (excluding terminated ones)
  const sessionProcesses = useMemo(() => {
    if (!runData?.processes) return [];
    
    return Object.entries(runData.processes)
      .map(([key, proc]) => {
        // Calculate if process is still running (not terminated by us)
        const isTerminated = terminatedPids.has(proc.pid);
        
        return {
          key,
          ...proc,
          status: isTerminated ? 'terminated' : 'running'
        };
      })
      // Only include processes with major page faults > 0
      .filter(proc => proc.totalMajor > 0 || (proc.samples && proc.samples.some(s => s.majorFaults > 0)))
      // Merge with fetched user info
      .map(proc => {
        const userInfo = processUsers[proc.pid];
        return {
          ...proc,
          user: userInfo?.user || proc.user || 'unknown',
          isRoot: userInfo?.isRoot || (proc.user?.toLowerCase() === 'root') || false
        };
      })
      .sort((a, b) => {
        if (sortBy === 'name') {
          return sortOrder === 'desc' 
            ? (b[sortBy] || '').localeCompare(a[sortBy] || '')
            : (a[sortBy] || '').localeCompare(b[sortBy] || '');
        }
        const aVal = a[sortBy] || 0;
        const bVal = b[sortBy] || 0;
        return sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
      });
  }, [runData?.processes, sortBy, sortOrder, terminatedPids, processUsers]);

  // Active processes (not terminated)
  const activeProcesses = useMemo(() => {
    return sessionProcesses.filter(p => p.status !== 'terminated');
  }, [sessionProcesses]);

  // Filtered processes for display
  const filteredProcesses = useMemo(() => {
    let result = sessionProcesses;
    
    // Filter by hide terminated
    if (hideTerminated) {
      result = result.filter(proc => proc.status !== 'terminated');
    }
    
    // Filter by search term
    if (processFilter) {
      const filter = processFilter.toLowerCase();
      result = result.filter(proc => 
        proc.name?.toLowerCase().includes(filter) ||
        String(proc.pid).includes(filter) ||
        proc.user?.toLowerCase().includes(filter)
      );
    }
    
    return result;
  }, [sessionProcesses, processFilter, hideTerminated]);

  // Fetch user information for all processes
  useEffect(() => {
    const fetchProcessUsers = async () => {
      if (!runData?.processes || Object.keys(runData.processes).length === 0) return;
      if (fetchUsersPending.current) return;
      
      // Get all unique PIDs that we haven't fetched yet
      const allPids = Object.values(runData.processes)
        .map(proc => proc.pid)
        .filter(pid => pid !== undefined && pid !== null);
      
      // Only fetch PIDs we don't have yet (use ref to avoid stale closure)
      const pidsToFetch = allPids.filter(pid => !processUsersRef.current[pid]);
      
      if (pidsToFetch.length === 0) return;
      
      fetchUsersPending.current = true;
      console.log('[AnalyserTab] Fetching users for PIDs:', pidsToFetch);
      
      try {
        const response = await fetch(`${API_URL}/process-users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pids: pidsToFetch })
        });
        
        if (response.ok) {
          const data = await response.json();
          console.log('[AnalyserTab] Received user data:', data);
          if (data.users) {
            setProcessUsers(prev => ({ ...prev, ...data.users }));
          }
        } else {
          console.error('[AnalyserTab] Failed to fetch users:', response.status);
        }
      } catch (err) {
        console.error('[AnalyserTab] Error fetching process users:', err);
      } finally {
        fetchUsersPending.current = false;
      }
    };
    
    // Fetch immediately
    fetchProcessUsers();
    
    // Also set up a periodic refresh every 5 seconds for new processes
    const interval = setInterval(fetchProcessUsers, 5000);
    
    return () => clearInterval(interval);
  }, [runData?.processes]); // Remove processUsers from dependencies to avoid stale closure

  // Continuous process liveness validation
  // Ensures only live processes appear in termination list
  useEffect(() => {
    const validateProcessLiveness = async () => {
      if (validationPending.current) return;
      if (!runData?.processes || Object.keys(runData.processes).length === 0) return;
      
      // Get all PIDs that are not already marked as terminated
      const pidsToValidate = Object.values(runData.processes)
        .filter(proc => !terminatedPids.has(proc.pid))
        .map(proc => proc.pid)
        .filter(pid => pid !== undefined && pid !== null);
      
      if (pidsToValidate.length === 0) return;
      
      validationPending.current = true;
      
      try {
        const response = await fetch(`${API_URL}/validate-processes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pids: pidsToValidate })
        });
        
        if (response.ok) {
          const data = await response.json();
          if (data.processes) {
            setProcessLiveness(prev => ({ ...prev, ...data.processes }));
            
            // Auto-mark dead processes as terminated
            Object.entries(data.processes).forEach(([pid, status]) => {
              if (!status.alive && !terminatedPids.has(parseInt(pid))) {
                console.log(`[AnalyserTab] Process ${pid} detected as dead`);
                setTerminatedPids(prev => new Set([...prev, parseInt(pid)]));
              }
            });
          }
        }
      } catch (err) {
        console.error('[AnalyserTab] Error validating process liveness:', err);
      } finally {
        validationPending.current = false;
      }
    };
    
    // Validate immediately
    validateProcessLiveness();
    
    // Then validate every 3 seconds for real-time updates
    const interval = setInterval(validateProcessLiveness, 3000);
    
    return () => clearInterval(interval);
  }, [runData?.processes, terminatedPids]);

  // Calculate graph data from run samples (recalculated excluding terminated processes)
  const graphData = useMemo(() => {
    if (!runData?.samples) return [];
    
    // Recalculate per-interval faults excluding terminated processes
    return runData.samples.slice(-60).map((sample, index) => {
      let faultsForSample = sample.majorFaults;
      
      // If we have terminated processes, recalculate
      if (terminatedPids.size > 0) {
        faultsForSample = 0;
        activeProcesses.forEach(proc => {
          if (proc.samples && proc.samples[index]) {
            faultsForSample += proc.samples[index].majorFaults || 0;
          }
        });
      }
      
      return {
        ...sample,
        majorFaults: faultsForSample,
        displayIndex: index + 1
      };
    });
  }, [runData?.samples, activeProcesses, terminatedPids]);

  // Calculate analysis statistics
  const analysisStats = useMemo(() => {
    if (!graphData || graphData.length === 0) {
      return {
        average: 0,
        peak: 0,
        total: 0,
        min: 0,
        peakTime: '-',
        sampleCount: 0,
        duration: 0,
        processCount: 0,
        activeProcessCount: 0
      };
    }
    
    const faults = graphData.map(d => d.majorFaults);
    const peakValue = Math.max(...faults);
    const peakIndex = faults.indexOf(peakValue);
    
    return {
      average: Math.round(faults.reduce((a, b) => a + b, 0) / faults.length),
      peak: peakValue,
      total: faults.reduce((a, b) => a + b, 0),
      min: Math.min(...faults),
      peakTime: graphData[peakIndex]?.time || '-',
      sampleCount: graphData.length,
      duration: runData?.startTime 
        ? Math.round((new Date() - new Date(runData.startTime)) / 1000)
        : 0,
      processCount: sessionProcesses.length,
      activeProcessCount: activeProcesses.length
    };
  }, [graphData, runData?.startTime, sessionProcesses.length, activeProcesses.length]);

  // Calculate memory pressure level - DYNAMIC based on current active processes
  const memoryPressure = useMemo(() => {
    if (!graphData || graphData.length < 3) {
      return { level: 'unknown', message: 'Collecting data...', color: '#8b949e', icon: '⏳' };
    }
    
    const faults = graphData.map(d => d.majorFaults);
    const avg = analysisStats.average;
    const peak = analysisStats.peak;
    
    // Get recent samples (last 1/3)
    const recentCount = Math.max(3, Math.ceil(faults.length / 3));
    const recentSamples = faults.slice(-recentCount);
    const recentAvg = recentSamples.reduce((a, b) => a + b, 0) / recentSamples.length;
    
    // Calculate variance in recent samples
    const recentVariance = recentSamples.reduce((sum, f) => sum + Math.pow(f - recentAvg, 2), 0) / recentSamples.length;
    const isStable = Math.sqrt(recentVariance) < (avg * 0.3 + 1);
    
    // Check for high fault frequency
    const highFaultThreshold = Math.max(avg * 1.5, 3);
    const highFaultCount = faults.filter(f => f > highFaultThreshold).length;
    const highFaultRatio = highFaultCount / faults.length;
    
    // Check trend
    const firstHalf = faults.slice(0, Math.floor(faults.length / 2));
    const secondHalf = faults.slice(Math.floor(faults.length / 2));
    const firstAvg = firstHalf.length > 0 ? firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length : 0;
    const secondAvg = secondHalf.length > 0 ? secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length : 0;
    const isTrendingUp = secondAvg > firstAvg * 1.2;
    const isTrendingDown = secondAvg < firstAvg * 0.8;
    
    // Check recent sustained high faults
    const recentHighFaults = recentSamples.filter(f => f > highFaultThreshold).length;
    const persistentHighFaults = recentHighFaults / recentSamples.length > 0.5;
    
    // Determine pressure level
    if (peak === 0 && avg === 0) {
      return {
        level: 'minimal',
        message: 'No significant page faults detected. System memory is operating normally.',
        color: '#7ee787',
        icon: '✅'
      };
    }
    
    if (persistentHighFaults || (highFaultRatio > 0.5 && isTrendingUp)) {
      return {
        level: 'high',
        message: 'Sustained high fault rates. System under significant memory pressure. Consider terminating memory-intensive processes below.',
        color: '#ff7b72',
        icon: '🔴'
      };
    }
    
    if (highFaultRatio > 0.3 && !isStable) {
      return {
        level: 'moderate',
        message: 'Elevated fault activity with instability. Monitor closely or terminate problematic processes.',
        color: '#d29922',
        icon: '🟡'
      };
    }
    
    if ((highFaultRatio > 0.1 && highFaultRatio <= 0.3) || (isTrendingUp && !isStable)) {
      return {
        level: 'moderate',
        message: 'Some memory pressure detected. Early spikes observed with possible stabilization ahead.',
        color: '#d29922',
        icon: '🟡'
      };
    }
    
    if (isStable || isTrendingDown) {
      return {
        level: 'low',
        message: 'Memory pressure is low. Fault rates have stabilized or are decreasing.',
        color: '#7ee787',
        icon: '🟢'
      };
    }
    
    return {
      level: 'low',
      message: 'Memory pressure is manageable. Monitoring continues.',
      color: '#7ee787',
      icon: '🟢'
    };
  }, [graphData, analysisStats]);

  // Check if a process is protected
  const isProcessProtected = useCallback((proc) => {
    // Check PID 0 and PID 1
    if (proc.pid === 0 || proc.pid === 1) {
      return { protected: true, reason: 'System critical process (PID 0/1)' };
    }
    
    // Check if process is root-owned (primary check)
    if (proc.isRoot || (proc.user && proc.user.toLowerCase() === 'root')) {
      return { protected: true, reason: 'Root process', isRoot: true };
    }
    
    // Check protected users
    if (proc.user && PROTECTED_USERS.includes(proc.user.toLowerCase())) {
      return { protected: true, reason: `System process owned by ${proc.user}`, isRoot: false };
    }
    
    // Check protected process names
    const procName = proc.name?.toLowerCase() || '';
    for (const pattern of PROTECTED_PROCESSES) {
      if (procName.includes(pattern.toLowerCase()) || procName.startsWith(pattern.toLowerCase())) {
        return { protected: true, reason: `System/kernel critical process` };
      }
    }
    
    // Check for kernel threads (usually in brackets)
    if (proc.name && proc.name.startsWith('[') && proc.name.endsWith(']')) {
      return { protected: true, reason: 'Kernel thread' };
    }
    
    return { protected: false, reason: null };
  }, []);

  // Handle process termination request - use displayed user value to decide authority
  const requestTermination = async (proc) => {
    // Quick pre-check for obvious system processes (PID 0/1, kernel threads)
    if (proc.pid === 0 || proc.pid === 1) {
      setTerminationError('Cannot terminate: System critical process (PID 0/1)');
      return;
    }
    
    if (proc.name && proc.name.startsWith('[') && proc.name.endsWith(']')) {
      setTerminationError('Cannot terminate: Kernel thread');
      return;
    }
    
    // Get the displayed user value from the process
    const displayedUser = proc.user || 'unknown';
    
    // Block termination if user is root (based on displayed user value)
    if (displayedUser.toLowerCase() === 'root') {
      setTerminationError(`Cannot terminate: This is a root process (owned by: ${displayedUser})`);
      return;
    }
    
    // Clear any previous errors
    setTerminationError(null);
    
    // Show confirmation dialog directly (no pre-check)
    // The actual termination will handle any errors if process doesn't exist
    setConfirmDialog({
      proc: { ...proc, user: displayedUser },
      message: `Are you sure you want to terminate this process?`,
      warning: 'This will kill the actual OS process. This action cannot be undone.'
    });
  };

  // Execute process termination with pre-validation
  const executeTermination = async () => {
    if (!confirmDialog?.proc) return;
    
    const proc = confirmDialog.proc;
    setConfirmDialog(null);
    setTerminatingPid(proc.pid);
    setTerminationError(null);
    
    try {
      // Step 1: Pre-validate the process is still alive and terminable
      const validateResponse = await fetch(`${API_URL}/validate-before-terminate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: proc.pid,
          processName: proc.name
        })
      });
      
      const validateData = await validateResponse.json();
      
      // If process is already dead, mark as terminated and show success
      if (!validateData.alive) {
        setTerminatedPids(prev => new Set([...prev, proc.pid]));
        setTerminationSuccess(`Process ${proc.name} (PID: ${proc.pid}) is no longer running`);
        if (logAction) {
          logAction('TERMINATE', {
            pid: proc.pid,
            name: proc.name,
            success: true,
            note: 'Process was already gone'
          });
        }
        return;
      }
      
      // If validation failed for other reasons (root process, PID reuse, etc.)
      if (!validateData.valid) {
        throw new Error(validateData.reason || 'Process validation failed');
      }
      
      // Step 2: Proceed with safe termination
      const response = await fetch(`${API_URL}/safe-terminate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: proc.pid,
          processName: proc.name
        })
      });
      
      const data = await response.json();
      
      // Check for successful termination OR process already gone
      if (response.ok && (data.success || data.alreadyTerminated)) {
        // Log the action
        if (logAction) {
          logAction('TERMINATE', {
            pid: proc.pid,
            name: proc.name,
            user: proc.user,
            success: true,
            alreadyTerminated: data.alreadyTerminated || false
          });
        }
        
        // Mark process as terminated
        setTerminatedPids(prev => new Set([...prev, proc.pid]));
        setTerminationSuccess(
          data.alreadyTerminated 
            ? `Process ${proc.name} (PID: ${proc.pid}) was already terminated`
            : `Process ${proc.name} (PID: ${proc.pid}) terminated successfully`
        );
      } else if (data.error?.includes('root') || data.error?.includes('Root')) {
        // Root process protection triggered at backend
        throw new Error('Cannot terminate: This is a root/system process');
      } else if (data.error?.includes('mismatch')) {
        // PID was reused by a different process
        throw new Error('Cannot terminate: PID has been reused by a different process');
      } else {
        throw new Error(data.error || 'Failed to terminate process');
      }
      
    } catch (err) {
      // Check if error indicates process is already gone
      if (err.message?.includes('No such process') || 
          err.message?.includes('already') ||
          err.message?.includes('no longer running')) {
        // Mark as terminated anyway
        setTerminatedPids(prev => new Set([...prev, proc.pid]));
        setTerminationSuccess(`Process ${proc.name} (PID: ${proc.pid}) is no longer running`);
        if (logAction) {
          logAction('TERMINATE', {
            pid: proc.pid,
            name: proc.name,
            user: proc.user,
            success: true,
            note: 'Process was already gone'
          });
        }
      } else {
        if (logAction) {
          logAction('TERMINATE_FAILED', {
            pid: proc.pid,
            name: proc.name,
            error: err.message
          });
        }
        setTerminationError(err.message);
      }
    } finally {
      setTerminatingPid(null);
    }
  };

  // Cancel termination dialog
  const cancelTermination = () => {
    setConfirmDialog(null);
  };

  // Check if a process is alive based on liveness validation
  const isProcessAlive = useCallback((pid) => {
    const status = processLiveness[pid];
    // If we haven't validated yet, assume alive
    if (!status) return true;
    return status.alive;
  }, [processLiveness]);

  // Calculate total session faults for each process
  const getProcessTotalFaults = (proc) => {
    if (proc.samples && proc.samples.length > 0) {
      return proc.samples.reduce((sum, s) => sum + (s.majorFaults || 0), 0);
    }
    return proc.totalMajor || 0;
  };

  // Get processes that exceed the fault threshold
  const getProcessesAboveThreshold = useCallback(() => {
    return activeProcesses.filter(proc => {
      const totalFaults = getProcessTotalFaults(proc);
      return totalFaults >= FAULT_THRESHOLD;
    });
  }, [activeProcesses, FAULT_THRESHOLD]);

  // Fetch fault reasoning from the backend
  const fetchFaultReasoning = useCallback(async () => {
    const highFaultProcesses = getProcessesAboveThreshold();
    
    if (highFaultProcesses.length === 0) {
      setReasonData({
        processes: [],
        systemMetrics: null,
        message: 'No processes currently exceed the fault threshold (1000 major page faults)'
      });
      setShowReasonModal(true);
      return;
    }

    setReasonLoading(true);
    setReasonError(null);
    setShowReasonModal(true);

    try {
      const pids = highFaultProcesses.map(p => p.pid);
      const response = await fetch(`${API_URL}/fault-reasoning`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pids })
      });

      if (!response.ok) {
        throw new Error('Failed to fetch fault reasoning');
      }

      const data = await response.json();
      
      // Merge with local process data for display
      const processesWithReasoning = highFaultProcesses.map(proc => {
        const reasoning = data.processes[proc.pid] || {};
        const totalFaults = getProcessTotalFaults(proc);
        
        return {
          pid: proc.pid,
          process_name: proc.name,
          major_page_faults: totalFaults,
          user: proc.user,
          ...reasoning
        };
      });

      // Sort by fault count descending
      processesWithReasoning.sort((a, b) => b.major_page_faults - a.major_page_faults);

      setReasonData({
        processes: processesWithReasoning,
        systemMetrics: data.systemMetrics,
        threshold: FAULT_THRESHOLD
      });

    } catch (err) {
      console.error('Fault reasoning error:', err);
      setReasonError(err.message);
    } finally {
      setReasonLoading(false);
    }
  }, [getProcessesAboveThreshold, FAULT_THRESHOLD]);

  // Close reason modal
  const closeReasonModal = () => {
    setShowReasonModal(false);
    setReasonData(null);
    setReasonError(null);
  };

  // Get category display info
  const getCategoryInfo = (category) => {
    const categories = {
      swap_pressure: { icon: '💾', label: 'Swap Pressure', color: '#ff7b72' },
      memory_thrashing: { icon: '🔄', label: 'Memory Thrashing', color: '#ff7b72' },
      memory_pressure: { icon: '⚠️', label: 'Memory Pressure', color: '#d29922' },
      warm_up: { icon: '🚀', label: 'Application Warm-up', color: '#58a6ff' },
      file_backed: { icon: '📁', label: 'File-backed Access', color: '#8b949e' },
      normal: { icon: '✅', label: 'Normal Activity', color: '#7ee787' },
      unknown: { icon: '❓', label: 'Unknown', color: '#8b949e' }
    };
    return categories[category] || categories.unknown;
  };

  // Get confidence badge color
  const getConfidenceColor = (confidence) => {
    const colors = {
      'High': '#7ee787',
      'Medium': '#d29922',
      'Low': '#8b949e'
    };
    return colors[confidence] || colors['Medium'];
  };

  // No data state
  if (!runData || !runData.samples || runData.samples.length === 0) {
    return (
      <div className="analyser-tab">
        <div className="no-data-container">
          <div className="no-data-icon">📭</div>
          <h2>Waiting for Monitoring Data</h2>
          <p>
            {isMonitoring 
              ? 'Monitoring is active. Data will appear here once samples are collected.'
              : 'Start monitoring in the Monitor tab to collect data for analysis.'}
          </p>
          {isMonitoring && (
            <div className="loading-dots">
              <span></span><span></span><span></span>
            </div>
          )}
          <div className="no-data-features">
            <div className="feature-item">
              <span className="feature-icon">📈</span>
              <span>Time-series visualization</span>
            </div>
            <div className="feature-item">
              <span className="feature-icon">🔍</span>
              <span>Memory pressure analysis</span>
            </div>
            <div className="feature-item">
              <span className="feature-icon">⚙️</span>
              <span>Process termination</span>
            </div>
            <div className="feature-item">
              <span className="feature-icon">📊</span>
              <span>Fault statistics</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="analyser-tab">
      {/* Confirmation Dialog */}
      {confirmDialog && (
        <div className="dialog-overlay">
          <div className="confirm-dialog">
            <div className="dialog-header">
              <span className="dialog-icon">⚠️</span>
              <h3>Confirm Process Termination</h3>
            </div>
            <div className="dialog-body">
              <div className="process-details-box">
                <div className="detail-row">
                  <span className="detail-label">Process Name:</span>
                  <span className="detail-value">{confirmDialog.proc.name}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">PID:</span>
                  <span className="detail-value">{confirmDialog.proc.pid}</span>
                </div>
                {confirmDialog.proc.user && (
                  <div className="detail-row">
                    <span className="detail-label">User:</span>
                    <span className="detail-value">{confirmDialog.proc.user}</span>
                  </div>
                )}
                <div className="detail-row">
                  <span className="detail-label">Major Faults:</span>
                  <span className="detail-value">{getProcessTotalFaults(confirmDialog.proc)}</span>
                </div>
              </div>
              <p className="dialog-message">{confirmDialog.message}</p>
              <p className="dialog-warning">⚠️ {confirmDialog.warning}</p>
            </div>
            <div className="dialog-actions">
              <button className="btn btn-secondary" onClick={cancelTermination}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={executeTermination}>
                🗑️ Terminate Process
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reason Modal - Threshold-based Major Page Fault Reasoning */}
      {showReasonModal && (
        <div className="dialog-overlay">
          <div className="reason-modal">
            <div className="reason-modal-header">
              <div className="reason-title-section">
                <span className="reason-modal-icon">🧾</span>
                <h3>Major Page Fault Reasoning</h3>
              </div>
              <button className="close-btn" onClick={closeReasonModal}>✕</button>
            </div>
            
            <div className="reason-modal-body">
              {reasonLoading ? (
                <div className="reason-loading">
                  <div className="spinner"></div>
                  <span>Analyzing processes...</span>
                </div>
              ) : reasonError ? (
                <div className="reason-error">
                  <span className="error-icon">❌</span>
                  <span>{reasonError}</span>
                </div>
              ) : reasonData?.message ? (
                <div className="reason-no-data">
                  <span className="no-data-icon">ℹ️</span>
                  <p>{reasonData.message}</p>
                  <span className="threshold-info">
                    Threshold: {FAULT_THRESHOLD.toLocaleString()} major page faults
                  </span>
                </div>
              ) : (
                <>
                  {/* System Metrics Summary */}
                  {reasonData?.systemMetrics && (
                    <div className="system-metrics-summary">
                      <h4>📊 System Status</h4>
                      <div className="metrics-grid">
                        <div className="metric-item">
                          <span className="metric-label">Swap Pressure</span>
                          <span className={`metric-value ${reasonData.systemMetrics.swapPressure > 50 ? 'high' : reasonData.systemMetrics.swapPressure > 30 ? 'medium' : 'low'}`}>
                            {reasonData.systemMetrics.swapPressure}%
                          </span>
                        </div>
                        <div className="metric-item">
                          <span className="metric-label">CPU I/O Wait</span>
                          <span className={`metric-value ${reasonData.systemMetrics.cpuIoWait > 20 ? 'high' : reasonData.systemMetrics.cpuIoWait > 10 ? 'medium' : 'low'}`}>
                            {reasonData.systemMetrics.cpuIoWait}%
                          </span>
                        </div>
                        <div className="metric-item">
                          <span className="metric-label">Memory Used</span>
                          <span className="metric-value">
                            {Math.round(reasonData.systemMetrics.memoryUsage / 1024 * 10) / 10} GB
                          </span>
                        </div>
                        <div className="metric-item">
                          <span className="metric-label">Swap Used</span>
                          <span className="metric-value">
                            {Math.round(reasonData.systemMetrics.swapUsage / 1024 * 10) / 10} GB
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Process Reasoning Cards */}
                  <div className="reason-threshold-info">
                    <span>⚡ Processes exceeding {FAULT_THRESHOLD.toLocaleString()} major page faults:</span>
                  </div>
                  
                  <div className="reason-cards-container">
                    {reasonData?.processes?.map((proc, index) => {
                      const categoryInfo = getCategoryInfo(proc.category);
                      return (
                        <div key={proc.pid} className="reason-card">
                          <div className="reason-card-header">
                            <div className="process-info">
                              <span className="process-rank">#{index + 1}</span>
                              <span className="process-name">{proc.process_name}</span>
                              <span className="process-pid">PID: {proc.pid}</span>
                            </div>
                            <div className="fault-count-badge">
                              <span className="fault-number">{proc.major_page_faults.toLocaleString()}</span>
                              <span className="fault-label">faults</span>
                            </div>
                          </div>
                          
                          <div className="reason-card-body">
                            {/* Category Tag */}
                            <div className="category-tag" style={{ backgroundColor: `${categoryInfo.color}22`, borderColor: categoryInfo.color }}>
                              <span className="category-icon">{categoryInfo.icon}</span>
                              <span className="category-label" style={{ color: categoryInfo.color }}>{categoryInfo.label}</span>
                            </div>
                            
                            {/* Main Reason */}
                            <div className="reason-text">
                              <p>{proc.reason}</p>
                            </div>
                            
                            {/* Confidence Badge */}
                            <div className="confidence-row">
                              <span className="confidence-label">Confidence:</span>
                              <span className="confidence-badge" style={{ color: getConfidenceColor(proc.confidence) }}>
                                {proc.confidence}
                              </span>
                            </div>
                            
                            {/* Details List */}
                            {proc.details && proc.details.length > 0 && (
                              <div className="reason-details">
                                <span className="details-header">Analysis Details:</span>
                                <ul>
                                  {proc.details.map((detail, idx) => (
                                    <li key={idx}>{detail}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            
                            {/* Metrics Row */}
                            {proc.metrics && (
                              <div className="process-metrics">
                                {proc.metrics.rssMB > 0 && (
                                  <span className="process-metric">RSS: {proc.metrics.rssMB}MB</span>
                                )}
                                {proc.metrics.vmSwapKB > 0 && (
                                  <span className="process-metric">Swap: {Math.round(proc.metrics.vmSwapKB / 1024)}MB</span>
                                )}
                                {proc.metrics.runtimeSeconds !== undefined && (
                                  <span className="process-metric">
                                    Runtime: {proc.metrics.runtimeSeconds > 60 
                                      ? `${Math.round(proc.metrics.runtimeSeconds / 60)}m` 
                                      : `${proc.metrics.runtimeSeconds}s`}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                          
                          {/* JSON Output for Copy */}
                          <div className="json-output-section">
                            <details>
                              <summary>📋 View JSON Output</summary>
                              <pre className="json-output">
{JSON.stringify({
  pid: proc.pid,
  process_name: proc.process_name,
  major_page_faults: proc.major_page_faults,
  reason: proc.reason,
  confidence: proc.confidence
}, null, 2)}
                              </pre>
                            </details>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
            
            <div className="reason-modal-footer">
              <span className="footer-info">
                Analysis based on swap usage, RSS behavior, CPU I/O wait, and process runtime
              </span>
              <button className="btn btn-primary" onClick={closeReasonModal}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Status Messages */}
      {terminationSuccess && (
        <div className="status-toast success">
          <span className="toast-icon">✅</span>
          <span>{terminationSuccess}</span>
        </div>
      )}
      
      {terminationError && (
        <div className="status-toast error">
          <span className="toast-icon">❌</span>
          <span>{terminationError}</span>
        </div>
      )}

      {/* Header */}
      <div className="analyser-header">
        <div className="header-left">
          <h2>🔬 Session Analysis</h2>
          <span className="run-meta">
            {runData.startTime && (
              <>
                Started: {new Date(runData.startTime).toLocaleString()} • 
                {analysisStats.sampleCount} samples • 
                {analysisStats.duration}s
                {isMonitoring && <span className="live-badge">● LIVE</span>}
              </>
            )}
          </span>
        </div>
        <div className="header-actions">
          <button 
            className="btn btn-secondary reason-tab" 
            type="button"
            onClick={fetchFaultReasoning}
          >
            🧾 Reason
            {getProcessesAboveThreshold().length > 0 && (
              <span className="reason-badge">{getProcessesAboveThreshold().length}</span>
            )}
          </button>
          <button className="btn btn-secondary" onClick={onClearRun}>
            🗑️ Clear Session
          </button>
        </div>
      </div>

      {/* Memory Pressure Indicator */}
      <div className={`pressure-indicator pressure-${memoryPressure.level}`}>
        <div className="pressure-header">
          <span className="pressure-icon">{memoryPressure.icon}</span>
          <span className="pressure-title">Memory Pressure Rate</span>
          <span className="pressure-level" style={{ color: memoryPressure.color }}>
            {memoryPressure.level.toUpperCase()}
          </span>
        </div>
        <p className="pressure-message">{memoryPressure.message}</p>
        <div className="pressure-metrics">
          <div className="pressure-metric">
            <span className="metric-value">{analysisStats.average}</span>
            <span className="metric-label">Avg Faults/Int</span>
          </div>
          <div className="pressure-metric">
            <span className="metric-value">{analysisStats.peak}</span>
            <span className="metric-label">Peak Faults</span>
          </div>
          <div className="pressure-metric">
            <span className="metric-value">{analysisStats.total}</span>
            <span className="metric-label">Total Faults</span>
          </div>
          <div className="pressure-metric">
            <span className="metric-value">{analysisStats.activeProcessCount}</span>
            <span className="metric-label">Active Processes</span>
          </div>
        </div>
      </div>

      {/* Graph Section - Full Width at Top */}
      <div className="graph-section-full">
        <div className="section-header">
          <h3>📈 Major Page Faults Over Time</h3>
          <span className="section-subtitle">
            Per-interval fault count • {isMonitoring ? 'Live updating' : 'Session complete'}
            {terminatedPids.size > 0 && ` • ${terminatedPids.size} process(es) terminated`}
          </span>
        </div>
        
        <div className="graph-container-large">
          <ResponsiveContainer width="100%" height={300}>
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
                formatter={(value) => [value, 'Major Faults']}
                labelFormatter={(label) => `Time: ${label}`}
              />
              <ReferenceLine 
                y={analysisStats.average} 
                stroke="#d29922" 
                strokeDasharray="5 5"
                label={{ value: 'Avg', position: 'right', fill: '#d29922', fontSize: 10 }}
              />
              <Legend />
              <Line 
                type="monotone" 
                dataKey="majorFaults" 
                stroke="#58a6ff" 
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 6, fill: '#58a6ff' }}
                name="Major Faults/Interval"
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Process Table Section - Full Width Below Graph */}
      <div className="process-table-section">
        <div className="section-header">
          <div className="section-title-group">
            <h3>⚙️ Session Processes with Page Faults</h3>
            <span className="section-subtitle">
              {sessionProcesses.length} processes recorded • {activeProcesses.length} active • {terminatedPids.size} terminated
            </span>
          </div>
          <div className="section-controls">
            <input
              type="text"
              placeholder="Filter by PID, name, or user..."
              value={processFilter}
              onChange={(e) => setProcessFilter(e.target.value)}
              className="filter-input"
            />
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={hideTerminated}
                onChange={(e) => setHideTerminated(e.target.checked)}
              />
              <span className="toggle-text">Hide Terminated</span>
            </label>
            <select 
              value={sortBy} 
              onChange={(e) => setSortBy(e.target.value)}
              className="sort-select"
            >
              <option value="totalMajor">Sort by Major Faults</option>
              <option value="name">Sort by Name</option>
              <option value="pid">Sort by PID</option>
            </select>
            <button 
              className="btn btn-small"
              onClick={() => setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc')}
              title={sortOrder === 'desc' ? 'Descending' : 'Ascending'}
            >
              {sortOrder === 'desc' ? '↓' : '↑'}
            </button>
          </div>
        </div>

        <div className="process-table-container">
          <table className="process-table">
            <thead>
              <tr>
                <th className="col-pid">PID</th>
                <th className="col-name">Process Name</th>
                <th className="col-user">User / Owner</th>
                <th className="col-faults">Major Page Faults</th>
                <th className="col-status">Status</th>
                <th className="col-action">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredProcesses.length > 0 ? (
                filteredProcesses.map((proc) => {
                  const isTerminating = terminatingPid === proc.pid;
                  const isTerminated = proc.status === 'terminated';
                  // Determine if user is root based on displayed user value
                  const displayedUser = proc.user || 'unknown';
                  const isRootUser = displayedUser.toLowerCase() === 'root';
                  const totalFaults = getProcessTotalFaults(proc);
                  const processAlive = isProcessAlive(proc.pid);
                  
                  return (
                    <tr 
                      key={proc.key}
                      className={`
                        ${isTerminating ? 'terminating' : ''} 
                        ${isTerminated || !processAlive ? 'terminated' : ''}
                        ${isRootUser ? 'root-process' : ''}
                      `}
                    >
                      <td className="col-pid">
                        <span className="pid-value">{proc.pid}</span>
                      </td>
                      <td className="col-name">
                        <span className="process-name-text">{proc.name}</span>
                      </td>
                      <td className="col-user">
                        <span className={`user-badge ${isRootUser ? 'user-root' : 'user-normal'}`}>
                          {displayedUser}
                        </span>
                      </td>
                      <td className="col-faults">
                        <span className="fault-count">{totalFaults}</span>
                        {proc.samples && proc.samples.length > 0 && (
                          <span className="fault-rate">
                            ({Math.round(totalFaults / proc.samples.length * 10) / 10}/int)
                          </span>
                        )}
                      </td>
                      <td className="col-status">
                        {isTerminated ? (
                          <span className="status-badge terminated">Terminated</span>
                        ) : !processAlive ? (
                          <span className="status-badge terminated">Gone</span>
                        ) : (
                          <span className="status-badge running">Running</span>
                        )}
                      </td>
                      <td className="col-action">
                        {isTerminated ? (
                          <span className="action-done">✓ Done</span>
                        ) : !processAlive ? (
                          <span className="action-done">⚫ Process Exited</span>
                        ) : isRootUser ? (
                          <div className="protected-action">
                            <button 
                              className="btn btn-small btn-terminate btn-disabled"
                              disabled={true}
                              title="Cannot terminate root process"
                            >
                              🔒 Terminate
                            </button>
                            <span className="protected-label">Protected (root process)</span>
                          </div>
                        ) : isTerminating ? (
                          <span className="terminating-spinner">⏳ Verifying...</span>
                        ) : (
                          <button 
                            className="btn btn-small btn-terminate btn-active"
                            onClick={() => requestTermination(proc)}
                            title="Terminate this process"
                          >
                            🗑️ Terminate
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan="6" className="no-processes-row">
                    {sessionProcesses.length === 0 
                      ? 'No processes with page faults recorded yet'
                      : 'No processes match the filter criteria'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="process-table-footer">
          <div className="footer-warnings">
            <div className="warning-item">
              <span className="warning-icon">🔒</span>
              <span>Protected: Root/system processes cannot be terminated</span>
            </div>
            <div className="warning-item">
              <span className="warning-icon">⚠️</span>
              <span>Terminate: Kills the actual OS process (WSL/Ubuntu)</span>
            </div>
          </div>
          <div className="footer-stats">
            <span>Session Total: <strong>{analysisStats.total}</strong> major faults</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AnalyserTab;
