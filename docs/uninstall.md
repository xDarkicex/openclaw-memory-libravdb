# Uninstall Guide

This guide covers safe removal of the OpenClaw / OpenClaw.ai plugin and the
separately managed `libravdbd` daemon.

If you only want to disable the memory replacement temporarily, remove the
plugin slot assignment first and leave the daemon plus data in place.

## 1. Disable the Plugin

Remove the plugin from the active OpenClaw slot in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {}
  }
}
```

Treat that JSON as a minimal example only. If you assigned `libravdb-memory`
under `memory` or `contextEngine`, remove just that slot entry and leave any
other plugin slots intact.

If you installed the package through the OpenClaw.ai plugin UI, remove or
disable the same package there as well. If you use the CLI, remove it through
your standard OpenClaw plugin removal flow for
`@xdarkicex/openclaw-memory-libravdb`.

## 2. Stop the Daemon

Stop the sidecar before deleting binaries or stored data.

Homebrew:

```bash
brew services stop libravdbd
```

Linux user service:

```bash
systemctl --user disable --now libravdbd.service
```

macOS LaunchAgent:

```bash
launchctl unload ~/Library/LaunchAgents/com.xdarkicex.libravdbd.plist
```

Foreground manual run:

- stop the `libravdbd serve` process in the terminal where it is running

## 3. Remove Installed Assets

### Plugin Package

Remove the published plugin package from OpenClaw or OpenClaw.ai after it is no
longer assigned to an active slot.

### Homebrew Daemon

```bash
brew uninstall libravdbd
brew untap xDarkicex/openclaw-libravdb-memory
```

### Manual Daemon Install

Delete the service file or launch agent you installed, along with the daemon
binary you copied into place.

Common locations:

- `~/.config/systemd/user/libravdbd.service`
- `~/Library/LaunchAgents/com.xdarkicex.libravdbd.plist`
- `~/.local/bin/libravdbd`

## 4. Optional Full Data Cleanup

Only do this if you want to permanently remove stored LibraVDB memory.

Common local state:

- socket directory: `~/.clawdb/run/`
- database file: `~/.clawdb/data.libravdb`

If you configured a custom `sidecarPath` or `dbPath`, remove those custom
locations instead of the defaults.

## 5. Post-Uninstall Check

After cleanup, `openclaw memory status` should no longer show this plugin as the
active memory provider, and the daemon endpoint should no longer be reachable
unless you intentionally kept it running for another workflow.
