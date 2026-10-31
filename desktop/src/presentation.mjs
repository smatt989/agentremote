// Presentation only: keep original provider records for history/provenance.
export function presentMessage(message) {
  if (['thinking','redacted_thinking','reasoning'].includes(message.kind)) return null;
  if (!message.text?.trim()) return null;
  // Claude Code records "a background job finished" notices as user turns; show them as a quiet status line, not as something the user said.
  if(message.role==='user'&&/^\s*<task-notification>/.test(message.text)){
    const summary=/<summary>([\s\S]*?)<\/summary>/.exec(message.text)?.[1]?.trim();
    return {...message,role:'system',kind:'status',text:summary?`Background task: ${summary}`:'A background task finished.'};
  }
  if(message.kind==='tool_use'||message.kind==='tool_result') {
    let block;try{block=JSON.parse(message.text);}catch{return message;}
    if(block.type==='tool_use') {
      if(block.name==='AskUserQuestion'||block.name?.endsWith('ask_question'))return null;
      const input=block.input||{};
      const labels={Bash:'Running command',Read:'Reading file',Write:'Writing file',Edit:'Editing file',Grep:'Searching files',Glob:'Finding files',WebSearch:'Searching the web',WebFetch:'Reading webpage'};
      return {...message,role:'tool',kind:labels[block.name]||block.name||'Tool',text:input.command||input.file_path||input.pattern||input.query||input.url||input.description||'Tool call',details:JSON.stringify(input,null,2)};
    }
    const content=typeof block.content==='string'?block.content:(block.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
    return {...message,role:'tool',kind:block.is_error?'Tool error':'Tool result',text:content||'Completed'};
  }
  return message;
}
export function claudeStatus(agent, fallback='idle') {
  if(!agent)return fallback;
  if(agent.status==='waiting'||agent.state==='blocked')return 'waiting';
  if(['busy','running','working'].includes(agent.status)||agent.state==='working')return 'running';
  if(agent.state==='failed')return 'error';
  return 'idle';
}
// A "spawn <cli> ENOENT" means the agent's command-line tool is missing. Say that, and how to fix it, in words a new user can act on.
export const isMissingCommand=error=>error?.code==='ENOENT'&&/^spawn\b/.test(error.syscall||'');
export function missingAgent(name,error){
  if(!isMissingCommand(error))return error;
  const app=name==='codex'?'Codex':'Claude',product=name==='codex'?'Codex':'Claude Code';
  return Object.assign(new Error(`${product} isn't installed on this Mac. Open Agent Remote on the Mac and click Install ${app}.`),{status:424,code:'AGENT_NOT_INSTALLED',agent:name,cause:error});
}
