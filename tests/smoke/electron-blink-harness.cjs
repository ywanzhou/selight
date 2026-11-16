// Node launcher for the Ruling 18 Blink webp smoke harness. Run after a build:
//
//   npm run build && node tests/smoke/electron-blink-harness.cjs
//
// It spawns the bundled out/main/harness.js inside a real Electron process, waits
// for the assertion exit code, then kills the whole Electron process tree
// (taskkill /T) and prints WMI zero-remainder evidence. Exit code is non-zero when
// the harness assertions fail OR any harness Electron process survives cleanup.
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const electronExe = require('electron')
const harness = path.resolve(__dirname, '..', '..', 'out', 'main', 'harness.js')

if (!fs.existsSync(harness)) {
  console.error(`[harness] ${harness} missing — run "npm run build" first`)
  process.exit(2)
}

const child = spawn(electronExe, [harness], { stdio: 'inherit' })
let timedOut = false
const guard = setTimeout(() => {
  timedOut = true
  console.error('[harness] 120s guard tripped; killing the process tree')
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}, 120_000)

child.on('close', (code) => {
  clearTimeout(guard)

  // Defensive tree cleanup: normally every renderer/utility child exits with the
  // main process, so this finds nothing, but run it anyway and record the result.
  const kill = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
    encoding: 'utf8'
  })
  const killNote = kill.status === 0 ? kill.stdout.trim() : `no remaining tree (rc=${kill.status})`
  console.log(`[harness] taskkill /PID ${child.pid} /T /F -> ${killNote}`)

  // WMI zero-remainder evidence: count Electron processes whose command line names
  // this harness, regardless of how many unrelated Electron apps may be running.
  const ps =
    "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*harness.js*' } | " +
    'Measure-Object | Select-Object -ExpandProperty Count'
  const wmi = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
  const remainder = Number(wmi.stdout.trim())
  console.log(`[harness] WMI remainder (electron.exe *harness.js*): ${wmi.stdout.trim()}`)

  const ok = !timedOut && code === 0 && remainder === 0 && wmi.status === 0
  process.exit(ok ? 0 : 1)
})
