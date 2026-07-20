import { isAbsolute } from "node:path";

export interface ServiceDefinitionOptions {
  readonly nodePath: string;
  readonly runtimePath: string;
  readonly stateRoot?: string;
}

export function systemdUserUnit(options: ServiceDefinitionOptions): string {
  validate(options);
  const environment =
    options.stateRoot === undefined
      ? ""
      : `Environment=PIFLEET_STATE_ROOT=${systemdEscape(options.stateRoot)}\n`;
  return `[Unit]
Description=pi-fleet user runtime
After=default.target

[Service]
Type=simple
ExecStart=${systemdEscape(options.nodePath)} ${systemdEscape(options.runtimePath)}
${environment}Restart=on-failure
RestartSec=1
TimeoutStopSec=10
UMask=0077
KillMode=control-group

[Install]
WantedBy=default.target
`;
}

export function launchdAgentPlist(options: ServiceDefinitionOptions): string {
  validate(options);
  const environment =
    options.stateRoot === undefined
      ? ""
      : `    <key>EnvironmentVariables</key>
    <dict><key>PIFLEET_STATE_ROOT</key><string>${xmlEscape(options.stateRoot)}</string></dict>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>works.elpapi.pifleet</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xmlEscape(options.nodePath)}</string>
        <string>${xmlEscape(options.runtimePath)}</string>
    </array>
${environment}    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
    <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

function validate(options: ServiceDefinitionOptions): void {
  if (!isAbsolute(options.nodePath) || !isAbsolute(options.runtimePath)) {
    throw new Error("Service executables must use absolute paths");
  }
}

function systemdEscape(value: string): string {
  if (!/^[A-Za-z0-9_./:@-]+$/.test(value)) throw new Error(`Unsafe systemd path ${value}`);
  return value;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
