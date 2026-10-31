import { Store } from './store.mjs';
import { RelayState } from './relay-state.mjs';
import QRCode from 'qrcode';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const store=new Store();const state=new RelayState(store);
try {
  switch(process.argv[2]){
    case 'configure':console.log(`Relay configured: ${state.configure(process.argv[3])}. Restart the Mac service to connect.`);break;
    case 'pair-native':{
      const {uri,invite}=state.invite();
      const image=await QRCode.toDataURL(uri,{errorCorrectionLevel:'M',margin:2,width:640});
      console.log(JSON.stringify({image,uri,expires:invite.expires}));break;
    }
    case 'keep-awake':{
      const {keepAwakeEnabled,setKeepAwake}=await import('./keep-awake.mjs');const value=process.argv[3];
      if(value!==undefined&&!['on','off'].includes(value))throw new Error('Usage: node desktop/src/admin.mjs keep-awake [on|off]');
      // The running service rereads this setting every few seconds.
      console.log(JSON.stringify(value===undefined?{enabled:keepAwakeEnabled(store)}:setKeepAwake(store,value==='on')));break;
    }
    case 'desktop-token':console.log(store.desktopToken());break;
    case 'desktop-info':
      console.log(JSON.stringify({activeSessions:store.sessions().filter(s=>s.external===false && ['running','submitting','waiting'].includes(s.status)).length,pairedDevices:store.db.prepare('SELECT COUNT(*) AS count FROM devices').get().count}));break;
    case 'pair':{
      const {uri,invite}=state.invite();
      const svg=await QRCode.toString(uri,{type:'svg',errorCorrectionLevel:'M',margin:2});
      const path=join(store.directory,'pair-iphone.html');
      const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>Pair your iPhone</title><style>body{font:17px system-ui;background:#101616;color:#e7efed;text-align:center;padding:5vh 24px}main{max-width:440px;margin:auto}svg{width:100%;background:white;border-radius:18px}h1{font-size:34px}p{line-height:1.5;color:#b9ceca}.tag{color:#65e7cc;font-size:12px;letter-spacing:.15em}</style></head><body><main><p class="tag">AGENT REMOTE</p><h1>Pair your iPhone</h1><p>Open Agent Remote on your phone and tap <strong>Scan QR code</strong>.</p><div id="qr">${svg}</div><p id="expiry">This code works once and expires in five minutes.</p><p>Your sessions and encryption keys stay on your devices.</p></main><script>setTimeout(()=>{document.getElementById('qr').remove();document.getElementById('expiry').textContent='This code has expired. Generate a new one on your Mac.'},Math.max(0,${invite.expires}-Date.now()));</script></body></html>`;
      writeFileSync(path,html,{mode:0o600});
      console.log(`Open this local file to scan the QR code:\n${path}\nExpires in five minutes. No VPN or server address is needed on the phone.`);
      break;
    }
    case 'pair-code':console.log(state.invite().uri);break;
    case 'pair-direct':console.log(`Legacy direct pairing code:\n${store.pairCode()}`);break;
    case 'devices':console.table(store.db.prepare('SELECT id,name,created FROM devices').all());break;
    case 'push-test':{
      const {ReplyNotifier,ALERTS}=await import('./reply-notifications.mjs');
      const notifier=new ReplyNotifier(store,{discover:async()=>{},history:async()=>{}});
      if(!notifier.local()){console.log(store.db.prepare("SELECT 1 FROM settings WHERE key='relayPushTopics'").get()?'This Mac sends notifications through the relay; push-test only checks a local Apple key. Lock your iPhone and wait for the next reply instead.':'Apple Push is not configured on this Mac. Run: python3 scripts/configure-push.py');break;}
      const devices=notifier.devices();
      if(!devices.length){console.log('No iPhone has enabled notifications yet. In the iPhone app open the gear menu → Notifications and turn them on.');break;}
      for(const device of devices){
        try{await notifier.push(device,{id:'push-test:'+Date.now()},ALERTS.test);console.log(`Sent a test notification to device ${device.device} (${device.topic}, ${device.environment}).`);}
        catch(error){console.log(`Device ${device.device} (${device.topic}, ${device.environment}): ${error.message}`);}
      }
      break;
    }
    case 'revoke':{
      const id=process.argv[3]||'';store.db.prepare('DELETE FROM devices WHERE id=?').run(id);store.db.prepare('DELETE FROM relay_devices WHERE id=?').run(id);console.log('Device revoked.');break;
    }
    default:console.log('Usage: npm run configure -- wss://relay-host | npm run pair | npm run devices | node desktop/src/admin.mjs revoke DEVICE_ID | node desktop/src/admin.mjs push-test | node desktop/src/admin.mjs keep-awake [on|off]');
  }
}catch(error){console.error(error.message);process.exitCode=1;}finally{store.close();}
