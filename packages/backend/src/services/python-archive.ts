import { execFileSync } from 'node:child_process';

/** Keep archive paths out of PowerShell source, including quotes and shell metacharacters. */
export function extractPythonArchive(archive: string, destination: string): void {
  execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:DPRO_PYTHON_ARCHIVE -DestinationPath $env:DPRO_PYTHON_DESTINATION -Force",
  ], {
    env: { ...process.env, DPRO_PYTHON_ARCHIVE: archive, DPRO_PYTHON_DESTINATION: destination },
    stdio: 'inherit', timeout: 120000,
  });
}
