const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Path to the faultstat executable
const FAULTSTAT_PATH = path.join(__dirname, '..', 'build', 'PageFaultStat');

// Check if we're on Windows and need to use WSL
const isWindows = os.platform() === 'win32';

// Get memory and swap info from /proc/meminfo
function getMemoryInfo() {
  return new Promise((resolve) => {
    if (isWindows) {
      // On Windows, run through WSL
      const wsl = spawn('wsl', ['cat', '/proc/meminfo']);
      let data = '';
      
      wsl.stdout.on('data', chunk => {
        data += chunk.toString();
      });
      
      wsl.on('close', () => {
        const info = parseMeminfo(data);
        resolve(info);
      });
      
      wsl.on('error', () => {
        resolve({ memoryUsage: 0, memoryTotal: 16384, swapUsage: 0, swapTotal: 8192 });
      });
    } else {
      fs.readFile('/proc/meminfo', 'utf8', (err, data) => {
        if (err) {
          resolve({ memoryUsage: 0, memoryTotal: 16384, swapUsage: 0, swapTotal: 8192 });
          return;
        }
        const info = parseMeminfo(data);
        resolve(info);
      });
    }
  });
}

// Get system information
function getSystemInfo() {
  return new Promise((resolve) => {
    const info = {
      hostname: 'Unknown',
      kernel_version: 'Unknown',
      uptime: 0
    };

    if (isWindows) {
      // Get hostname
      const hostname = spawn('wsl', ['-d', 'Ubuntu', 'cat', '/proc/sys/kernel/hostname']);
      let hostnameData = '';
      
      hostname.stdout.on('data', chunk => {
        hostnameData += chunk.toString();
      });
      
      hostname.on('close', () => {
        info.hostname = hostnameData.trim();
        
        // Get kernel version
        const kernel = spawn('wsl', ['-d', 'Ubuntu', 'uname', '-r']);
        let kernelData = '';
        
        kernel.stdout.on('data', chunk => {
          kernelData += chunk.toString();
        });
        
        kernel.on('close', () => {
          info.kernel_version = kernelData.trim();
          
          // Get uptime
          const uptime = spawn('wsl', ['-d', 'Ubuntu', 'cat', '/proc/uptime']);
          let uptimeData = '';
          
          uptime.stdout.on('data', chunk => {
            uptimeData += chunk.toString();
          });
          
          uptime.on('close', () => {
            const uptimeSeconds = parseFloat(uptimeData.split(' ')[0]);
            info.uptime = Math.floor(uptimeSeconds);
            resolve(info);
          });
          
          uptime.on('error', () => resolve(info));
        });
        
        kernel.on('error', () => resolve(info));
      });
      
      hostname.on('error', () => resolve(info));
    } else {
      // Linux implementation
      fs.readFile('/proc/sys/kernel/hostname', 'utf8', (err, data) => {
        if (!err) info.hostname = data.trim();
        
        const kernel = spawn('uname', ['-r']);
        let kernelData = '';
        
        kernel.stdout.on('data', chunk => {
          kernelData += chunk.toString();
        });
        
        kernel.on('close', () => {
          info.kernel_version = kernelData.trim();
          
          fs.readFile('/proc/uptime', 'utf8', (err, data) => {
            if (!err) {
              const uptimeSeconds = parseFloat(data.split(' ')[0]);
              info.uptime = Math.floor(uptimeSeconds);
            }
            resolve(info);
          });
        });
      });
    }
  });
}

// Get CPU information
function getCPUInfo() {
  return new Promise((resolve) => {
    const cpuInfo = {
      model: 'Unknown',
      cores: 0,
      speed: 0
    };

    if (isWindows) {
      const cpuinfo = spawn('wsl', ['-d', 'Ubuntu', 'cat', '/proc/cpuinfo']);
      let data = '';
      
      cpuinfo.stdout.on('data', chunk => {
        data += chunk.toString();
      });
      
      cpuinfo.on('close', () => {
        const info = parseCPUInfo(data);
        resolve(info);
      });
      
      cpuinfo.on('error', () => resolve(cpuInfo));
    } else {
      fs.readFile('/proc/cpuinfo', 'utf8', (err, data) => {
        if (err) {
          resolve(cpuInfo);
          return;
        }
        const info = parseCPUInfo(data);
        resolve(info);
      });
    }
  });
}

function parseCPUInfo(data) {
  const lines = data.split('\n');
  const cpuInfo = {
    model: 'Unknown',
    cores: 0,
    speed: 0
  };
  
  let processorCount = 0;
  
  lines.forEach(line => {
    if (line.startsWith('model name')) {
      cpuInfo.model = line.split(':')[1].trim();
    } else if (line.startsWith('processor')) {
      processorCount++;
    } else if (line.startsWith('cpu MHz')) {
      const speed = parseFloat(line.split(':')[1].trim());
      if (speed > cpuInfo.speed) {
        cpuInfo.speed = Math.round(speed);
      }
    }
  });
  
  cpuInfo.cores = processorCount;
  
  return cpuInfo;
}

function parseMeminfo(data) {
  const lines = data.split('\n');
  const info = {};
  
  lines.forEach(line => {
    const parts = line.split(':');
    if (parts.length === 2) {
      const key = parts[0].trim();
      const value = parseInt(parts[1].trim().split(' ')[0]);
      info[key] = value;
    }
  });

  const memoryTotal = Math.round((info['MemTotal'] || 16384000) / 1024);
  const memoryAvailable = Math.round((info['MemAvailable'] || 0) / 1024);
  const memoryUsage = memoryTotal - memoryAvailable;

  const swapTotal = Math.round((info['SwapTotal'] || 8192000) / 1024);
  const swapFree = Math.round((info['SwapFree'] || swapTotal) / 1024);
  const swapUsage = swapTotal - swapFree;

  return {
    memoryUsage,
    memoryTotal,
    swapUsage,
    swapTotal
  };
}

// API endpoint to get current fault statistics
app.get('/api/stats', async (req, res) => {
  try {
    // Check if faultstat executable exists
    if (!fs.existsSync(FAULTSTAT_PATH)) {
      return res.status(500).json({ 
        error: 'PageFaultStat executable not found. Please build it first using "make".',
        path: FAULTSTAT_PATH
      });
    }

    // Setup command based on OS
    let command, args;
    if (isWindows) {
      // Try different WSL path formats
      // Option 1: /mnt/host/e (Docker Desktop WSL)
      // Option 2: /mnt/e (Ubuntu WSL)
      // We'll use wsl -d Ubuntu to force Ubuntu distribution
      command = 'wsl';
      args = ['-d', 'Ubuntu', '/mnt/d/RVCE/EL-2025/OS/PageFaultStat/build/PageFaultStat', '-j'];
    } else {
      command = FAULTSTAT_PATH;
      args = ['-j'];
    }

    const faultstat = spawn(command, args);
    let jsonOutput = '';
    let errorOutput = '';

    faultstat.stdout.on('data', (data) => {
      jsonOutput += data.toString();
    });

    faultstat.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    faultstat.on('close', async (code) => {
      if (code !== 0 && code !== null) {
        console.error('PageFaultStat exited with code:', code);
        console.error('Error output:', errorOutput);
        return res.status(500).json({ 
          error: 'PageFaultStat execution failed',
          code: code,
          stderr: errorOutput
        });
      }

      try {
        // Parse JSON output from PageFaultStat
        // The output may have text before JSON and multiple JSON objects
        // Find the last complete JSON object
        const lines = jsonOutput.split('\n');
        let lastJsonLine = '';
        
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (line.startsWith('{') && line.endsWith('}')) {
            lastJsonLine = line;
            break;
          }
        }

        if (!lastJsonLine) {
          throw new Error('No valid JSON found in output');
        }

        const data = JSON.parse(lastJsonLine);
        const memoryInfo = await getMemoryInfo();
        const systemInfo = await getSystemInfo();
        const cpuInfo = await getCPUInfo();

        // Transform the data to match expected format
        const response = {
          ...systemInfo,
          cpu_info: cpuInfo,
          total_faults: data.totals?.major + data.totals?.minor || 0,
          major_faults: data.totals?.major || 0,
          minor_faults: data.totals?.minor || 0,
          faults_per_second: (data.totals?.deltaMajor || 0) + (data.totals?.deltaMinor || 0),
          top_processes: (data.processes || []).map(proc => ({
            pid: proc.pid,
            name: proc.command,
            user: proc.user,
            major_faults: proc.major || 0,
            minor_faults: proc.minor || 0,
            total_faults: (proc.major || 0) + (proc.minor || 0)
          })).sort((a, b) => b.total_faults - a.total_faults),
          timestamp: data.timestamp,
          ...memoryInfo
        };

        res.json(response);
      } catch (parseError) {
        console.error('JSON parse error:', parseError);
        console.error('Raw output:', jsonOutput);
        return res.status(500).json({ 
          error: 'Failed to parse PageFaultStat output',
          details: parseError.message,
          rawOutput: jsonOutput.substring(0, 500)
        });
      }
    });

    faultstat.on('error', (error) => {
      console.error('Failed to start PageFaultStat:', error);
      res.status(500).json({ 
        error: 'Failed to start PageFaultStat',
        details: error.message
      });
    });

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    faultstatPath: FAULTSTAT_PATH,
    faultstatExists: fs.existsSync(FAULTSTAT_PATH)
  });
});

// API endpoint to get raw terminal output
app.get('/api/raw-output', async (req, res) => {
  try {
    // Check if faultstat executable exists
    if (!fs.existsSync(FAULTSTAT_PATH)) {
      return res.status(500).json({ 
        error: 'PageFaultStat executable not found. Please build it first using "make".',
        path: FAULTSTAT_PATH
      });
    }

    // Get query parameters
    const interval = parseFloat(req.query.interval) || 1.0;
    const samples = parseInt(req.query.samples) || 0;
    const processName = req.query.process || '';
    const showAll = req.query.showAll === 'true';

    console.log(`[API] Received request - interval: ${interval}, samples: ${samples}, process: ${processName}, showAll: ${showAll}`);

    // Setup command based on OS
    let command, args;
    if (isWindows) {
      command = 'wsl';
      args = ['-d', 'Ubuntu', '/mnt/d/RVCE/EL-2025/OS/PageFaultStat/build/PageFaultStat'];
      
      // Add -a flag if showAll is enabled
      if (showAll) {
        args.push('-a');
      }
      
      // Add -p flag if process name is specified
      if (processName) {
        args.push('-p', processName);
      }
      
      // Always add interval
      args.push(interval.toString());
      // Only add samples if > 0 (0 means continuous, which is the default)
      if (samples > 0) {
        args.push(samples.toString());
      }
    } else {
      command = FAULTSTAT_PATH;
      args = [];
      
      // Add -a flag if showAll is enabled
      if (showAll) {
        args.push('-a');
      }
      
      // Add -p flag if process name is specified
      if (processName) {
        args.push('-p', processName);
      }
      
      // Always add interval
      args.push(interval.toString());
      // Only add samples if > 0 (0 means continuous, which is the default)
      if (samples > 0) {
        args.push(samples.toString());
      }
    }

    console.log(`[API] Executing command: ${command} ${args.join(' ')}`);

    const faultstat = spawn(command, args);
    let output = '';
    let errorOutput = '';
    let dataReceived = false;

    // For continuous mode (samples = 0), kill after first output
    const shouldKillAfterOutput = samples === 0;

    faultstat.stdout.on('data', (data) => {
      output += data.toString();
      
      // If continuous mode and we got data, kill the process after a short delay
      if (shouldKillAfterOutput && !dataReceived) {
        dataReceived = true;
        // Give it a moment to finish the current output, then kill
        setTimeout(() => {
          faultstat.kill();
        }, 100);
      }
    });

    faultstat.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    faultstat.on('close', (code) => {
      // Code will be null if killed, which is expected for continuous mode
      if (code !== 0 && code !== null) {
        console.error(`[API] PageFaultStat exited with code: ${code}`);
        console.error(`[API] Error output: ${errorOutput}`);
        return res.status(500).json({ 
          error: 'PageFaultStat execution failed',
          code: code,
          stderr: errorOutput
        });
      }

      console.log(`[API] Successfully executed, output length: ${output.length} chars`);
      res.json({ output, timestamp: new Date().toISOString() });
    });

    faultstat.on('error', (error) => {
      console.error(`[API] Failed to start PageFaultStat: ${error.message}`);
      res.status(500).json({ 
        error: 'Failed to start PageFaultStat',
        details: error.message
      });
    });

  } catch (err) {
    console.error(`[API] Internal server error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// API endpoint to get list of running processes
app.get('/api/processes', async (req, res) => {
  try {
    let command, args;
    
    if (isWindows) {
      // On Windows, use WSL to get processes
      command = 'wsl';
      args = ['-d', 'Ubuntu', 'ps', 'aux'];
    } else {
      command = 'ps';
      args = ['aux'];
    }

    const ps = spawn(command, args);
    let output = '';
    let errorOutput = '';

    ps.stdout.on('data', (data) => {
      output += data.toString();
    });

    ps.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ps.on('close', (code) => {
      if (code !== 0) {
        return res.status(500).json({ 
          error: 'Failed to fetch processes', 
          details: errorOutput 
        });
      }

      // Parse process list
      const lines = output.trim().split('\\n');
      const processes = [];
      
      // Skip header line
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Extract process name (last column)
        const parts = line.split(/\\s+/);
        if (parts.length >= 11) {
          const processName = parts[10];
          // Get just the command name without path
          const baseName = processName.split('/').pop().split(' ')[0];
          
          // Filter out some system processes and duplicates
          if (baseName && 
              baseName !== 'ps' && 
              baseName !== 'wsl' &&
              !processes.includes(baseName)) {
            processes.push(baseName);
          }
        }
      }

      // Sort alphabetically
      processes.sort((a, b) => a.localeCompare(b));

      res.json({ processes });
    });

    ps.on('error', (err) => {
      res.status(500).json({ 
        error: 'Failed to execute ps command', 
        details: err.message 
      });
    });

  } catch (err) {
    console.error(`[API] Error fetching processes: ${err.message}`);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Protected processes that should NOT be terminated (kernel/system critical only)
const PROTECTED_PROCESSES = [
  'init', 'systemd', 'kthreadd', 'ksoftirqd', 'kworker', 'migration',
  'watchdog', 'rcu_', 'kdevtmpfs', 'kswapd', 'ksmd', 'khugepaged'
];

const PROTECTED_USERS = ['root'];

// API endpoint to get detailed process list with PID, name, user
app.get('/api/process-info', async (req, res) => {
  try {
    let command, args;
    
    if (isWindows) {
      command = 'wsl';
      args = ['-d', 'Ubuntu', 'ps', '-eo', 'pid,user,comm', '--no-headers'];
    } else {
      command = 'ps';
      args = ['-eo', 'pid,user,comm', '--no-headers'];
    }

    const ps = spawn(command, args);
    let output = '';
    let errorOutput = '';

    ps.stdout.on('data', (data) => {
      output += data.toString();
    });

    ps.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ps.on('close', (code) => {
      if (code !== 0) {
        return res.status(500).json({ 
          error: 'Failed to fetch process info', 
          details: errorOutput 
        });
      }

      const processes = [];
      const lines = output.trim().split('\n');
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 3) {
          const pid = parseInt(parts[0]);
          const user = parts[1];
          const name = parts.slice(2).join(' ');
          
          if (!isNaN(pid) && name) {
            processes.push({ pid, user, name });
          }
        }
      }

      // Sort by PID
      processes.sort((a, b) => a.pid - b.pid);

      res.json({ processes });
    });

    ps.on('error', (err) => {
      res.status(500).json({ 
        error: 'Failed to execute ps command', 
        details: err.message 
      });
    });

  } catch (err) {
    console.error(`[API] Error fetching process info: ${err.message}`);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// API endpoint to terminate a process
app.post('/api/terminate-process', async (req, res) => {
  const { pid, processName } = req.body;
  
  console.log(`[API] Terminate request - PID: ${pid}, Name: ${processName}`);
  
  // Validate input
  if (!pid || isNaN(parseInt(pid))) {
    return res.status(400).json({ error: 'Invalid PID provided' });
  }
  
  const pidNum = parseInt(pid);
  
  // Protection: PID 0 and 1 are always protected
  if (pidNum === 0 || pidNum === 1) {
    return res.status(403).json({ 
      error: 'Cannot terminate system critical process (PID 0/1)' 
    });
  }
  
  // Protection: Check if process name is protected (only match base name, not full path)
  if (processName) {
    // Extract base name from path (e.g., '/mnt/d/path/to/process' -> 'process')
    const baseName = processName.split('/').pop().split(' ')[0].toLowerCase();
    
    for (const protectedName of PROTECTED_PROCESSES) {
      // Only match if base name starts with protected name (for patterns like 'rcu_')
      // or is an exact match
      if (baseName === protectedName.toLowerCase() || 
          baseName.startsWith(protectedName.toLowerCase())) {
        return res.status(403).json({ 
          error: `Cannot terminate protected system process: ${baseName}` 
        });
      }
    }
  }
  
  try {
    // First, get the process owner to check if it's a root process
    let command, args;
    
    if (isWindows) {
      command = 'wsl';
      args = ['-d', 'Ubuntu', 'ps', '-o', 'user=', '-p', pidNum.toString()];
    } else {
      command = 'ps';
      args = ['-o', 'user=', '-p', pidNum.toString()];
    }
    
    const checkPs = spawn(command, args);
    let userOutput = '';
    let psError = '';
    
    checkPs.stdout.on('data', (data) => {
      userOutput += data.toString();
    });
    
    checkPs.stderr.on('data', (data) => {
      psError += data.toString();
    });
    
    checkPs.on('close', async (code) => {
      const user = userOutput.trim();
      
      console.log(`[API] ps check - code: ${code}, user: "${user}", error: "${psError}"`);
      
      // If we got a user and it's root, block termination
      if (user && PROTECTED_USERS.includes(user.toLowerCase())) {
        return res.status(403).json({ 
          error: `Cannot terminate root/system process owned by: ${user}` 
        });
      }
      
      // Proceed with termination (even if ps failed - process might still exist or be gone)
      // Using SIGTERM first, then SIGKILL
      let killCommand, killArgs;
      
      if (isWindows) {
        killCommand = 'wsl';
        killArgs = ['-d', 'Ubuntu', 'kill', '-15', pidNum.toString()];
      } else {
        killCommand = 'kill';
        killArgs = ['-15', pidNum.toString()];
      }
      
      console.log(`[API] Sending SIGTERM to PID ${pidNum}`);
      
      const kill = spawn(killCommand, killArgs);
      let killError = '';
      let killStdout = '';
      
      kill.stdout.on('data', (data) => {
        killStdout += data.toString();
      });
      
      kill.stderr.on('data', (data) => {
        killError += data.toString();
      });
      
      kill.on('close', (killCode) => {
        console.log(`[API] SIGTERM result - code: ${killCode}, stdout: "${killStdout}", stderr: "${killError}"`);
        
        if (killCode !== 0) {
          // Process might already be gone or need SIGKILL
          if (killError.includes('No such process') || killError.includes('no process') || 
              killError.includes('does not exist') || psError.includes('No such process')) {
            return res.json({ 
              success: true, 
              message: 'Process already terminated',
              pid: pidNum 
            });
          }
          
          // Try SIGKILL as fallback
          let sigkillArgs;
          if (isWindows) {
            sigkillArgs = ['-d', 'Ubuntu', 'kill', '-9', pidNum.toString()];
          } else {
            sigkillArgs = ['-9', pidNum.toString()];
          }
          
          console.log(`[API] SIGTERM failed, trying SIGKILL for PID ${pidNum}`);
          
          const sigkill = spawn(isWindows ? 'wsl' : 'kill', sigkillArgs);
          let sigkillError = '';
          
          sigkill.stderr.on('data', (data) => {
            sigkillError += data.toString();
          });
          
          sigkill.on('close', (sigkillCode) => {
            console.log(`[API] SIGKILL result - code: ${sigkillCode}, error: "${sigkillError}"`);
            
            if (sigkillCode !== 0) {
              // If SIGKILL also fails with "no such process", that's still success
              if (sigkillError.includes('No such process') || sigkillError.includes('no process')) {
                return res.json({ 
                  success: true, 
                  message: 'Process already terminated',
                  pid: pidNum 
                });
              }
              
              return res.status(500).json({ 
                error: 'Failed to terminate process',
                details: killError || sigkillError
              });
            }
            
            console.log(`[API] Process ${pidNum} terminated with SIGKILL`);
            res.json({ 
              success: true, 
              message: 'Process terminated successfully (SIGKILL)',
              pid: pidNum 
            });
          });
          
          return;
        }
        
        console.log(`[API] Process ${pidNum} terminated with SIGTERM`);
        res.json({ 
          success: true, 
          message: 'Process terminated successfully',
          pid: pidNum 
        });
      });
      
      kill.on('error', (err) => {
        console.error(`[API] Kill command error: ${err.message}`);
        res.status(500).json({ 
          error: 'Failed to execute kill command',
          details: err.message 
        });
      });
    });
    
    checkPs.on('error', (err) => {
      console.error(`[API] Process check error: ${err.message}`);
      res.status(500).json({ 
        error: 'Failed to check process ownership',
        details: err.message 
      });
    });
    
  } catch (err) {
    console.error(`[API] Terminate error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});


// API endpoint to get user of a specific process by PID
app.get('/api/process-user/:pid', async (req, res) => {
  const { pid } = req.params;
  
  if (!pid || isNaN(parseInt(pid))) {
    return res.status(400).json({ error: 'Invalid PID' });
  }

  try {
    let command, args;
    
    if (isWindows) {
      command = 'wsl';
      args = ['-d', 'Ubuntu', 'ps', '-o', 'user=', '-p', pid.toString()];
    } else {
      command = 'ps';
      args = ['-o', 'user=', '-p', pid.toString()];
    }

    const ps = spawn(command, args);
    let output = '';
    let errorOutput = '';

    ps.stdout.on('data', (data) => {
      output += data.toString();
    });

    ps.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ps.on('close', (code) => {
      const user = output.trim();
      
      if (!user || code !== 0) {
        // Process may have ended, return unknown
        return res.json({ pid: parseInt(pid), user: 'unknown', exists: false });
      }
      
      res.json({ 
        pid: parseInt(pid), 
        user: user,
        exists: true,
        isRoot: user.toLowerCase() === 'root'
      });
    });

    ps.on('error', (err) => {
      res.status(500).json({ error: 'Failed to get process user', details: err.message });
    });

  } catch (err) {
    console.error(`[API] Error getting process user: ${err.message}`);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// API endpoint to get all process users in batch (more efficient)
app.post('/api/process-users', async (req, res) => {
  const { pids } = req.body;
  
  if (!pids || !Array.isArray(pids)) {
    return res.status(400).json({ error: 'Invalid PIDs array' });
  }

  try {
    let command, args;
    
    if (isWindows) {
      command = 'wsl';
      args = ['-d', 'Ubuntu', 'ps', '-eo', 'pid,user', '--no-headers'];
    } else {
      command = 'ps';
      args = ['-eo', 'pid,user', '--no-headers'];
    }

    const ps = spawn(command, args);
    let output = '';
    let stderrOutput = '';

    console.log(`[API] Running: ${command} ${args.join(' ')}`);

    ps.stdout.on('data', (data) => {
      output += data.toString();
    });

    ps.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    ps.on('close', (code) => {
      console.log(`[API] ps command closed with code: ${code}`);
      console.log(`[API] ps output length: ${output.length} chars`);
      if (stderrOutput) {
        console.log(`[API] ps stderr: ${stderrOutput}`);
      }
      
      const userMap = {};
      const lines = output.trim().split('\n');
      
      console.log(`[API] Found ${lines.length} lines`);
      console.log(`[API] First 3 lines:`, lines.slice(0, 3));
      
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const pid = parseInt(parts[0]);
          const user = parts[1];
          if (!isNaN(pid)) {
            userMap[pid] = user;
          }
        }
      }
      
      console.log(`[API] Mapped ${Object.keys(userMap).length} processes`);
      
      // Map requested PIDs to their users
      const result = {};
      for (const pid of pids) {
        result[pid] = {
          user: userMap[pid] || 'unknown',
          isRoot: userMap[pid]?.toLowerCase() === 'root',
          exists: !!userMap[pid]
        };
      }
      
      console.log(`[API] Returning users for PIDs:`, pids, result);
      res.json({ users: result });
    });

    ps.on('error', (err) => {
      res.status(500).json({ error: 'Failed to get process users', details: err.message });
    });

  } catch (err) {
    console.error(`[API] Error getting process users: ${err.message}`);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// ============================================================
// SAFE PROCESS-TERMINATION DATA PROVIDER
// Ensures only live processes appear in termination UI
// ============================================================

// Helper function to check if a single process is alive
// Uses /proc/[pid] existence check for efficiency
function checkProcessAlive(pid) {
  return new Promise((resolve) => {
    if (isWindows) {
      // Use WSL to check /proc/[pid] existence
      const wsl = spawn('wsl', ['-d', 'Ubuntu', 'test', '-d', `/proc/${pid}`]);
      wsl.on('close', (code) => {
        resolve(code === 0);
      });
      wsl.on('error', () => resolve(false));
    } else {
      // Direct /proc check on Linux
      fs.access(`/proc/${pid}`, fs.constants.F_OK, (err) => {
        resolve(!err);
      });
    }
  });
}

// Helper function to get process info if alive
function getProcessInfoIfAlive(pid) {
  return new Promise((resolve) => {
    if (isWindows) {
      const script = `
        if [ -d /proc/${pid} ]; then
          ps -p ${pid} -o pid=,user=,comm= 2>/dev/null | head -1
        fi
      `;
      const wsl = spawn('wsl', ['-d', 'Ubuntu', 'bash', '-c', script]);
      let output = '';
      wsl.stdout.on('data', (data) => { output += data.toString(); });
      wsl.on('close', (code) => {
        const line = output.trim();
        if (!line) {
          resolve(null);
          return;
        }
        const parts = line.split(/\s+/);
        if (parts.length >= 3) {
          resolve({
            pid: parseInt(parts[0]),
            user: parts[1],
            name: parts.slice(2).join(' '),
            alive: true
          });
        } else {
          resolve(null);
        }
      });
      wsl.on('error', () => resolve(null));
    } else {
      const ps = spawn('ps', ['-p', pid.toString(), '-o', 'pid=,user=,comm=']);
      let output = '';
      ps.stdout.on('data', (data) => { output += data.toString(); });
      ps.on('close', () => {
        const line = output.trim();
        if (!line) {
          resolve(null);
          return;
        }
        const parts = line.split(/\s+/);
        if (parts.length >= 3) {
          resolve({
            pid: parseInt(parts[0]),
            user: parts[1],
            name: parts.slice(2).join(' '),
            alive: true
          });
        } else {
          resolve(null);
        }
      });
      ps.on('error', () => resolve(null));
    }
  });
}

// API endpoint to validate multiple PIDs are still alive
// Used for continuous real-time validation in the UI
app.post('/api/validate-processes', async (req, res) => {
  const { pids } = req.body;
  
  if (!pids || !Array.isArray(pids)) {
    return res.status(400).json({ error: 'Invalid PIDs array' });
  }

  console.log(`[API] Validating ${pids.length} processes`);

  try {
    // Parallel validation for efficiency
    const validationResults = await Promise.all(
      pids.map(async (pid) => {
        const alive = await checkProcessAlive(pid);
        return { pid, alive };
      })
    );

    // Build response map
    const results = {};
    for (const { pid, alive } of validationResults) {
      results[pid] = { alive, timestamp: Date.now() };
    }

    res.json({ 
      processes: results,
      validatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error(`[API] Process validation error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// API endpoint to get all active (terminable) processes
// Returns only processes that are currently alive and terminable
app.get('/api/active-processes', async (req, res) => {
  try {
    let command, args;
    
    if (isWindows) {
      command = 'wsl';
      // Get PID, USER, and COMMAND for all processes
      args = ['-d', 'Ubuntu', 'ps', '-eo', 'pid,user,comm', '--no-headers'];
    } else {
      command = 'ps';
      args = ['-eo', 'pid,user,comm', '--no-headers'];
    }

    const ps = spawn(command, args);
    let output = '';
    let errorOutput = '';

    ps.stdout.on('data', (data) => {
      output += data.toString();
    });

    ps.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ps.on('close', (code) => {
      if (code !== 0) {
        return res.status(500).json({ 
          error: 'Failed to fetch active processes', 
          details: errorOutput 
        });
      }

      const processes = [];
      const lines = output.trim().split('\n');
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 3) {
          const pid = parseInt(parts[0]);
          const user = parts[1];
          const name = parts.slice(2).join(' ');
          
          if (!isNaN(pid) && name) {
            // Determine if process is terminable
            const isProtectedPid = pid === 0 || pid === 1;
            const isRootUser = user.toLowerCase() === 'root';
            const isKernelThread = name.startsWith('[') && name.endsWith(']');
            
            // Check against protected process list
            const baseName = name.split('/').pop().split(' ')[0].toLowerCase();
            let isProtectedProcess = false;
            for (const protectedName of PROTECTED_PROCESSES) {
              if (baseName === protectedName.toLowerCase() || 
                  baseName.startsWith(protectedName.toLowerCase())) {
                isProtectedProcess = true;
                break;
              }
            }

            processes.push({ 
              pid, 
              user, 
              name,
              alive: true,
              terminable: !isProtectedPid && !isRootUser && !isKernelThread && !isProtectedProcess,
              protectionReason: isProtectedPid ? 'System critical PID' :
                               isRootUser ? 'Root process' :
                               isKernelThread ? 'Kernel thread' :
                               isProtectedProcess ? 'Protected system process' : null
            });
          }
        }
      }

      // Sort by PID
      processes.sort((a, b) => a.pid - b.pid);

      res.json({ 
        processes,
        count: processes.length,
        terminableCount: processes.filter(p => p.terminable).length,
        timestamp: new Date().toISOString()
      });
    });

    ps.on('error', (err) => {
      res.status(500).json({ 
        error: 'Failed to execute ps command', 
        details: err.message 
      });
    });

  } catch (err) {
    console.error(`[API] Error fetching active processes: ${err.message}`);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// API endpoint to validate a process immediately before termination
// This is the final check to handle race conditions
app.post('/api/validate-before-terminate', async (req, res) => {
  const { pid, processName } = req.body;
  
  if (!pid || isNaN(parseInt(pid))) {
    return res.status(400).json({ error: 'Invalid PID' });
  }

  const pidNum = parseInt(pid);
  console.log(`[API] Pre-termination validation for PID: ${pidNum}`);

  try {
    // Get full process info to verify it's the same process
    const processInfo = await getProcessInfoIfAlive(pidNum);
    
    if (!processInfo) {
      // Process no longer exists
      return res.json({
        valid: false,
        alive: false,
        reason: 'Process has already terminated',
        pid: pidNum,
        timestamp: new Date().toISOString()
      });
    }

    // Verify process name matches (to catch PID reuse)
    if (processName) {
      const expectedBaseName = processName.split('/').pop().split(' ')[0].toLowerCase();
      const actualBaseName = processInfo.name.split('/').pop().split(' ')[0].toLowerCase();
      
      if (expectedBaseName !== actualBaseName) {
        return res.json({
          valid: false,
          alive: true,
          reason: `PID reused by different process (expected: ${expectedBaseName}, actual: ${actualBaseName})`,
          pid: pidNum,
          actualProcess: processInfo,
          timestamp: new Date().toISOString()
        });
      }
    }

    // Check if process is protected
    const isRootUser = processInfo.user.toLowerCase() === 'root';
    if (isRootUser) {
      return res.json({
        valid: false,
        alive: true,
        reason: 'Cannot terminate root process',
        pid: pidNum,
        processInfo,
        timestamp: new Date().toISOString()
      });
    }

    // All checks passed
    res.json({
      valid: true,
      alive: true,
      pid: pidNum,
      processInfo,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error(`[API] Pre-termination validation error: ${err.message}`);
    res.status(500).json({ error: 'Validation failed', details: err.message });
  }
});

// API endpoint for safe termination with built-in validation
// Combines validation and termination in one atomic operation
app.post('/api/safe-terminate', async (req, res) => {
  const { pid, processName } = req.body;
  
  if (!pid || isNaN(parseInt(pid))) {
    return res.status(400).json({ error: 'Invalid PID provided' });
  }

  const pidNum = parseInt(pid);
  console.log(`[API] Safe terminate request - PID: ${pidNum}, Name: ${processName}`);

  try {
    // Step 1: Validate process is alive and terminable
    const processInfo = await getProcessInfoIfAlive(pidNum);
    
    if (!processInfo) {
      return res.json({
        success: true,
        alreadyTerminated: true,
        message: 'Process already terminated or does not exist',
        pid: pidNum
      });
    }

    // Step 2: Protection checks
    if (pidNum === 0 || pidNum === 1) {
      return res.status(403).json({ 
        error: 'Cannot terminate system critical process (PID 0/1)' 
      });
    }

    if (processInfo.user.toLowerCase() === 'root') {
      return res.status(403).json({ 
        error: `Cannot terminate root process owned by: ${processInfo.user}` 
      });
    }

    // Step 3: Check protected process names
    const baseName = processInfo.name.split('/').pop().split(' ')[0].toLowerCase();
    for (const protectedName of PROTECTED_PROCESSES) {
      if (baseName === protectedName.toLowerCase() || 
          baseName.startsWith(protectedName.toLowerCase())) {
        return res.status(403).json({ 
          error: `Cannot terminate protected system process: ${baseName}` 
        });
      }
    }

    // Step 4: Verify name matches if provided (prevent PID reuse attacks)
    if (processName) {
      const expectedBaseName = processName.split('/').pop().split(' ')[0].toLowerCase();
      if (expectedBaseName !== baseName) {
        return res.status(400).json({
          error: 'Process identity mismatch - PID may have been reused',
          expected: expectedBaseName,
          actual: baseName
        });
      }
    }

    // Step 5: Final alive check right before kill
    const stillAlive = await checkProcessAlive(pidNum);
    if (!stillAlive) {
      return res.json({
        success: true,
        alreadyTerminated: true,
        message: 'Process terminated between validation and kill',
        pid: pidNum
      });
    }

    // Step 6: Execute termination
    let killCommand, killArgs;
    if (isWindows) {
      killCommand = 'wsl';
      killArgs = ['-d', 'Ubuntu', 'kill', '-15', pidNum.toString()];
    } else {
      killCommand = 'kill';
      killArgs = ['-15', pidNum.toString()];
    }

    const kill = spawn(killCommand, killArgs);
    let killError = '';

    kill.stderr.on('data', (data) => {
      killError += data.toString();
    });

    kill.on('close', async (killCode) => {
      // Check if process is now gone
      const processGone = !(await checkProcessAlive(pidNum));

      if (killCode === 0 || processGone) {
        console.log(`[API] Process ${pidNum} terminated successfully`);
        return res.json({
          success: true,
          message: 'Process terminated successfully',
          pid: pidNum,
          processName: processInfo.name
        });
      }

      // Try SIGKILL if SIGTERM failed
      console.log(`[API] SIGTERM failed, trying SIGKILL for PID ${pidNum}`);
      
      let sigkillArgs;
      if (isWindows) {
        sigkillArgs = ['-d', 'Ubuntu', 'kill', '-9', pidNum.toString()];
      } else {
        sigkillArgs = ['-9', pidNum.toString()];
      }

      const sigkill = spawn(isWindows ? 'wsl' : 'kill', sigkillArgs);

      sigkill.on('close', async () => {
        const finalCheck = !(await checkProcessAlive(pidNum));
        if (finalCheck) {
          return res.json({
            success: true,
            message: 'Process terminated with SIGKILL',
            pid: pidNum
          });
        }
        
        return res.status(500).json({
          error: 'Failed to terminate process',
          details: killError
        });
      });
    });

    kill.on('error', (err) => {
      console.error(`[API] Kill command error: ${err.message}`);
      res.status(500).json({
        error: 'Failed to execute kill command',
        details: err.message
      });
    });

  } catch (err) {
    console.error(`[API] Safe terminate error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// API endpoint to get fault reasoning metrics for processes
// Used by the Reason tab for threshold-based major page fault analysis
app.post('/api/fault-reasoning', async (req, res) => {
  const { pids } = req.body;
  
  if (!pids || !Array.isArray(pids)) {
    return res.status(400).json({ error: 'Invalid PIDs array' });
  }

  console.log(`[API] Fault reasoning request for PIDs: ${pids.join(', ')}`);

  try {
    // Get system-wide metrics first
    const memInfo = await getMemoryInfo();
    
    // Calculate swap pressure percentage
    const swapPressure = memInfo.swapTotal > 0 
      ? Math.round((memInfo.swapUsage / memInfo.swapTotal) * 100) 
      : 0;
    
    // Get CPU I/O wait from /proc/stat
    const cpuIoWait = await getCpuIoWait();
    
    // Get per-process metrics
    const processMetrics = await Promise.all(
      pids.map(pid => getProcessMetrics(pid))
    );
    
    // Build result with reasoning
    const results = {};
    for (let i = 0; i < pids.length; i++) {
      const pid = pids[i];
      const metrics = processMetrics[i];
      
      if (metrics) {
        const reasoning = generateFaultReasoning(metrics, swapPressure, cpuIoWait, memInfo);
        results[pid] = {
          ...metrics,
          swapPressure,
          cpuIoWait,
          ...reasoning
        };
      } else {
        results[pid] = {
          exists: false,
          reason: 'Process no longer running',
          category: 'unknown',
          confidence: 'Low'
        };
      }
    }
    
    res.json({ 
      processes: results,
      systemMetrics: {
        swapPressure,
        cpuIoWait,
        memoryUsage: memInfo.memoryUsage,
        memoryTotal: memInfo.memoryTotal,
        swapUsage: memInfo.swapUsage,
        swapTotal: memInfo.swapTotal
      }
    });
    
  } catch (err) {
    console.error(`[API] Fault reasoning error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Get CPU I/O wait percentage from /proc/stat
function getCpuIoWait() {
  return new Promise((resolve) => {
    const runCommand = (cmd, args) => {
      const proc = spawn(cmd, args);
      let data = '';
      proc.stdout.on('data', chunk => { data += chunk.toString(); });
      proc.on('close', () => resolve(parseCpuIoWait(data)));
      proc.on('error', () => resolve(0));
    };

    if (isWindows) {
      runCommand('wsl', ['-d', 'Ubuntu', 'cat', '/proc/stat']);
    } else {
      runCommand('cat', ['/proc/stat']);
    }
  });
}

function parseCpuIoWait(data) {
  // Format: cpu user nice system idle iowait irq softirq steal guest guest_nice
  const cpuLine = data.split('\n').find(line => line.startsWith('cpu '));
  if (!cpuLine) return 0;
  
  const parts = cpuLine.split(/\s+/);
  if (parts.length < 6) return 0;
  
  const user = parseInt(parts[1]) || 0;
  const nice = parseInt(parts[2]) || 0;
  const system = parseInt(parts[3]) || 0;
  const idle = parseInt(parts[4]) || 0;
  const iowait = parseInt(parts[5]) || 0;
  
  const total = user + nice + system + idle + iowait;
  if (total === 0) return 0;
  
  return Math.round((iowait / total) * 100);
}

// Get per-process metrics from /proc/[pid]/stat and /proc/[pid]/statm
function getProcessMetrics(pid) {
  return new Promise((resolve) => {
    if (isWindows) {
      // Run a single WSL command that gets all needed info
      const script = `
        if [ -d /proc/${pid} ]; then
          echo "EXISTS:yes"
          cat /proc/${pid}/stat 2>/dev/null | head -1
          echo "---STATM---"
          cat /proc/${pid}/statm 2>/dev/null | head -1
          echo "---STATUS---"
          cat /proc/${pid}/status 2>/dev/null | grep -E "^(Name|VmRSS|VmSwap|State):"
        else
          echo "EXISTS:no"
        fi
      `;
      
      const wsl = spawn('wsl', ['-d', 'Ubuntu', 'bash', '-c', script]);
      let data = '';
      
      wsl.stdout.on('data', chunk => { data += chunk.toString(); });
      wsl.on('close', () => {
        const result = parseProcessMetrics(pid, data);
        resolve(result);
      });
      wsl.on('error', () => resolve(null));
    } else {
      // Direct file reads on Linux
      const statPath = `/proc/${pid}/stat`;
      const statmPath = `/proc/${pid}/statm`;
      const statusPath = `/proc/${pid}/status`;
      
      Promise.all([
        fs.promises.readFile(statPath, 'utf8').catch(() => ''),
        fs.promises.readFile(statmPath, 'utf8').catch(() => ''),
        fs.promises.readFile(statusPath, 'utf8').catch(() => '')
      ]).then(([stat, statm, status]) => {
        const data = `EXISTS:yes\n${stat}\n---STATM---\n${statm}\n---STATUS---\n${status}`;
        resolve(parseProcessMetrics(pid, data));
      }).catch(() => resolve(null));
    }
  });
}

function parseProcessMetrics(pid, data) {
  if (!data.includes('EXISTS:yes')) {
    return null;
  }
  
  const lines = data.split('\n');
  let stat = '';
  let statm = '';
  let name = '';
  let vmRss = 0;
  let vmSwap = 0;
  let state = '';
  
  let section = 'stat';
  for (const line of lines) {
    if (line.includes('---STATM---')) {
      section = 'statm';
      continue;
    }
    if (line.includes('---STATUS---')) {
      section = 'status';
      continue;
    }
    if (line.startsWith('EXISTS:')) continue;
    
    if (section === 'stat' && line.trim() && !stat) {
      stat = line.trim();
    } else if (section === 'statm' && line.trim() && !statm) {
      statm = line.trim();
    } else if (section === 'status') {
      if (line.startsWith('Name:')) name = line.split(':')[1].trim();
      if (line.startsWith('VmRSS:')) vmRss = parseInt(line.split(':')[1].trim()) || 0;
      if (line.startsWith('VmSwap:')) vmSwap = parseInt(line.split(':')[1].trim()) || 0;
      if (line.startsWith('State:')) state = line.split(':')[1].trim().charAt(0);
    }
  }
  
  // Parse /proc/[pid]/stat
  // Format: pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice num_threads itrealvalue starttime vsize rss ...
  let startTime = 0;
  let majflt = 0;
  let minflt = 0;
  let utime = 0;
  let stime = 0;
  let vsize = 0;
  let rss = 0;
  
  if (stat) {
    // Handle comm which can contain spaces and parentheses
    const commEnd = stat.lastIndexOf(')');
    if (commEnd > 0) {
      const afterComm = stat.substring(commEnd + 2).split(/\s+/);
      // afterComm[0] = state, [1] = ppid, [2] = pgrp, [3] = session, [4] = tty_nr, [5] = tpgid, 
      // [6] = flags, [7] = minflt, [8] = cminflt, [9] = majflt, [10] = cmajflt,
      // [11] = utime, [12] = stime, [13] = cutime, [14] = cstime, [15] = priority,
      // [16] = nice, [17] = num_threads, [18] = itrealvalue, [19] = starttime,
      // [20] = vsize, [21] = rss
      minflt = parseInt(afterComm[7]) || 0;
      majflt = parseInt(afterComm[9]) || 0;
      utime = parseInt(afterComm[11]) || 0;
      stime = parseInt(afterComm[12]) || 0;
      startTime = parseInt(afterComm[19]) || 0;
      vsize = parseInt(afterComm[20]) || 0;
      rss = parseInt(afterComm[21]) || 0;
    }
  }
  
  // Parse /proc/[pid]/statm for more accurate RSS
  // Format: size resident shared text lib data dt
  let rssPages = 0;
  if (statm) {
    const parts = statm.split(/\s+/);
    rssPages = parseInt(parts[1]) || 0;
  }
  
  // Calculate runtime in seconds (approximate)
  // starttime is in clock ticks since boot, we need uptime to calculate actual runtime
  // For now, use a heuristic: if starttime is recent (small), process is new
  const uptimeClockTicks = Date.now() / 10; // rough approximation
  const runtimeTicks = uptimeClockTicks - startTime;
  const runtimeSeconds = Math.max(0, Math.round(runtimeTicks / 100)); // CLK_TCK is usually 100
  
  // Determine if process is in warm-up phase (running < 60 seconds)
  const isWarmingUp = runtimeSeconds < 60;
  
  // Calculate RSS in MB (page size is typically 4KB)
  const rssMB = Math.round((rssPages * 4) / 1024);
  
  // Determine if process has significant swap usage
  const hasSwapUsage = vmSwap > 1000; // > 1MB in swap
  
  return {
    pid,
    name: name || `pid:${pid}`,
    exists: true,
    state,
    majorFaults: majflt,
    minorFaults: minflt,
    rssMB,
    vmSwapKB: vmSwap,
    runtimeSeconds,
    isWarmingUp,
    hasSwapUsage,
    cpuTime: utime + stime
  };
}

// Generate reasoning for page faults based on collected metrics
function generateFaultReasoning(metrics, swapPressure, cpuIoWait, memInfo) {
  const reasons = [];
  let confidence = 'Medium';
  let category = 'unknown';
  let primaryReason = '';
  
  // Rule 1: Swap Pressure - High swap usage indicates memory eviction
  // If system swap usage > 50% AND process has swap usage, likely swap pressure
  if (swapPressure > 50 && metrics.hasSwapUsage) {
    reasons.push('High system swap pressure detected');
    reasons.push(`Process has ${Math.round(metrics.vmSwapKB / 1024)}MB in swap`);
    category = 'swap_pressure';
    primaryReason = 'Swap pressure caused by frequent memory eviction';
    confidence = 'High';
  }
  // Rule 2: Swap pressure alone (system-wide)
  else if (swapPressure > 70) {
    reasons.push('Severe system-wide swap pressure');
    category = 'swap_pressure';
    primaryReason = 'System under high swap pressure, causing page evictions';
    confidence = 'High';
  }
  
  // Rule 3: Application warm-up phase
  // New processes often generate many page faults as they load code/data
  if (metrics.isWarmingUp && !category) {
    reasons.push(`Process started recently (${metrics.runtimeSeconds}s ago)`);
    reasons.push('Initial page loading phase in progress');
    category = 'warm_up';
    primaryReason = 'Application warm-up phase - loading initial pages into memory';
    confidence = metrics.majorFaults > 5000 ? 'Medium' : 'High';
  }
  
  // Rule 4: Memory thrashing detection
  // High I/O wait combined with high fault rate suggests thrashing
  if (cpuIoWait > 20 && metrics.majorFaults > 2000) {
    if (!category || category === 'unknown') {
      category = 'memory_thrashing';
      primaryReason = 'Memory thrashing detected - frequent page swapping';
      confidence = 'High';
    }
    reasons.push(`High CPU I/O wait: ${cpuIoWait}%`);
    reasons.push('System spending significant time on disk I/O');
  }
  
  // Rule 5: File-backed memory access
  // If RSS is high but no swap pressure, likely accessing file-backed pages
  if (metrics.rssMB > 500 && swapPressure < 30 && !metrics.hasSwapUsage) {
    if (!category || category === 'unknown') {
      category = 'file_backed';
      primaryReason = 'File-backed memory access - reading data from disk';
      confidence = 'Medium';
    }
    reasons.push(`High RSS usage: ${metrics.rssMB}MB`);
    reasons.push('Likely accessing memory-mapped files or large data sets');
  }
  
  // Rule 6: Low memory available
  const memPressure = memInfo.memoryTotal > 0 
    ? Math.round((memInfo.memoryUsage / memInfo.memoryTotal) * 100) 
    : 0;
  if (memPressure > 85) {
    reasons.push(`High memory utilization: ${memPressure}%`);
    if (!category || category === 'unknown') {
      category = 'memory_pressure';
      primaryReason = 'System memory pressure forcing page evictions';
      confidence = 'High';
    }
  }
  
  // Default reasoning if no specific pattern matched
  if (!primaryReason) {
    primaryReason = 'Normal page fault activity during memory access';
    category = 'normal';
    confidence = 'Medium';
    reasons.push('No critical memory pressure indicators detected');
  }
  
  return {
    reason: primaryReason,
    category,
    confidence,
    details: reasons,
    metrics: {
      swapPressure,
      cpuIoWait,
      memPressure,
      rssMB: metrics.rssMB,
      vmSwapKB: metrics.vmSwapKB,
      runtimeSeconds: metrics.runtimeSeconds
    }
  };
}

// Start server
app.listen(PORT, () => {
  console.log(`╔════════════════════════════════════════════════════╗`);
  console.log(`║  PageFaultStat Backend API Server                 ║`);
  console.log(`╠════════════════════════════════════════════════════╣`);
  console.log(`║  Server running on: http://localhost:${PORT}       ║`);
  console.log(`║  API Endpoint:      /api/stats                     ║`);
  console.log(`║  Health Check:      /api/health                    ║`);
  console.log(`║  Faultstat Binary:  ${FAULTSTAT_PATH.padEnd(28)} ║`);
  console.log(`╚════════════════════════════════════════════════════╝`);
  
  if (!fs.existsSync(FAULTSTAT_PATH)) {
    console.log(`\n⚠️  WARNING: PageFaultStat executable not found!`);
    console.log(`   Run 'make' in the project root to build it.\n`);
  }
});
