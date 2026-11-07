// DSH Anywhere convenience launcher: all | relay | host | help
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, randomToken } from '../shared/protocol.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || '8787';
const HOST_BIND = process.env.HOST || '0.0.0.0';

function usage() {
  console.log('dsh-anywhere ' + VERSION);
  console.log('');
  console.log('Usage: node bin/cli.mjs <all|relay|host|help>');
  console.log('');
  console.log('  all    - start relay (hub) AND host adapter on this machine (one-click demo).');
  console.log('           host is auto-pointed at the local relay.');
  console.log('  relay  - start the relay/hub only (host the phone PWA).');
  console.log('  host   - start the host adapter only (tails this machine DSH sessions).');
  console.log('           requires DSH_ANYWHERE_RELAY (see help below).');
  console.log('  help   - show this message.');
  console.log('');
  console.log('Environment variables:');
  console.log('  PORT                    relay port (default 8787)');
  console.log('  HOST                    relay bind address (default 0.0.0.0)');
  console.log('  DSH_ANYWHERE_RELAY      relay URL for host (default http://127.0.0.1:<PORT> in all mode)');
  console.log('  DSH_ANYWHERE_TOKEN       shared secret (else auto-generated in ~/.dsh-anywhere/secret)');
  console.log('  DSH_ANYWHERE_HOME        state dir (default ~/.dsh-anywhere)');
  console.log('  DSH_HOME                DSH state dir (default ~/.dsh)');
  console.log('  DSH_ANYWHERE_HOST_NAME   friendly host name (default os.hostname)');
  console.log('  DSH_ANYWHERE_HOST_ID     stable host id (default persisted random)');
  console.log('');
  console.log('Typical multi-machine setup:');
  console.log('  [relay box]  node bin/cli.mjs relay');
  console.log('  [Windows]    DSH_ANYWHERE_RELAY=http://<relay>:8787 node bin/cli.mjs host');
  console.log('  [SteamDeck]  DSH_ANYWHERE_RELAY=http://<relay>:8787 node bin/cli.mjs host');
  console.log('  [phone]      open http://<relay>:8787/ , enter the 6-digit pairing code');
}

function run(file, env) {
  return spawn(process.execPath, [path.join(ROOT, file)], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, env || {}),
    windowsHide: true,
  });
}

const cmd = (process.argv[2] || 'help').toLowerCase();
if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
  usage();
} else if (cmd === 'relay') {
  run('relay/server.mjs', { PORT: PORT, HOST: HOST_BIND });
} else if (cmd === 'host') {
  if (!process.env.DSH_ANYWHERE_RELAY) {
    console.error('[cli] host mode needs DSH_ANYWHERE_RELAY, e.g. http://127.0.0.1:8787');
    console.error('[cli] (or use "all" to run relay+host together on this machine)');
    process.exit(2);
  }
  run('host/cli.mjs', {});
} else if (cmd === 'all') {
  // Both children must share ONE token. Previously each read <home>/secret,
  // but the host could start before the relay wrote it -> empty token -> 401.
  // Pass it explicitly so the one-click Linux package (no launcher env) is race-free.
  const sharedToken = process.env.DSH_ANYWHERE_TOKEN || randomToken();
  const relayEnv = { PORT: PORT, HOST: HOST_BIND, DSH_ANYWHERE_TOKEN: sharedToken };
  const hostEnv = { DSH_ANYWHERE_RELAY: process.env.DSH_ANYWHERE_RELAY || ('http://127.0.0.1:' + PORT), DSH_ANYWHERE_TOKEN: sharedToken };
  const relay = run('relay/server.mjs', relayEnv);
  const host = run('host/cli.mjs', hostEnv);
  const kids = [relay, host];
  let stopping = false;
  function stop() {
    if (stopping) return; stopping = true;
    for (const k of kids) { try { k.kill('SIGINT'); } catch (e) {} }
    setTimeout(() => process.exit(0), 800);
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  for (const k of kids) {
    k.on('exit', (code) => {
      if (!stopping) {
        console.error('[cli] a child exited with code ' + code + ', shutting down');
        stop();
      }
    });
  }
} else {
  console.error('[cli] unknown command: ' + cmd);
  usage();
  process.exit(1);
}
