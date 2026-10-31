// Sets the shared relay address included with distributed Mac installs. Contains no secret.
import {writeFileSync} from 'node:fs';
import {validateRelayURL} from '../shared/secure-channel.mjs';
const relay=validateRelayURL(process.argv[2]);
writeFileSync(new URL('../desktop/relay-default.json',import.meta.url),JSON.stringify({relay},null,2)+'\n');
console.log(`Default relay set to ${relay}. New Mac installs will connect automatically.`);
