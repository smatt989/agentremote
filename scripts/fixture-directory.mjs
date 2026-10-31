import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
// Created before a native provider starts, so the user's running app never
// imports disposable conversations while the fixture is active.
export function fixtureDirectory(prefix){
 const directory=mkdtempSync(join(tmpdir(),prefix));
 writeFileSync(join(directory,'.agent-remote-test-fixture'),'Disposable Agent Remote test workspace\n',{mode:0o600});
 return directory;
}
