// /dsh 命令解析：纯函数，方便单测。
// 语法：
//   /dsh <任务>      一次性交给 DSH
//   /dsh on|off      粘性开关
//   /dsh new|stop    新会话 / 中断
//   /dsh status|help
export const COMMANDS = ['on', 'off', 'new', 'stop', 'status', 'help'];

export function parseCommand(text, prefix = '/dsh') {
  const raw = String(text ?? '').trim();
  if (!raw.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const rest = raw.slice(prefix.length);
  if (rest && !/^\s/.test(rest)) return null; // /dshabc 不算
  const body = rest.trim();
  if (!body) return { kind: 'help' };
  const [head, ...tail] = body.split(/\s+/);
  const name = head.toLowerCase();
  if (COMMANDS.includes(name)) {
    if (name === 'on' || name === 'off' || name === 'new' || name === 'stop' || name === 'status' || name === 'help') {
      return tail.length ? { kind: 'prompt', text: body } : { kind: name };
    }
  }
  return { kind: 'prompt', text: body };
}

export const HELP_TEXT = [
  '/dsh <任务>   把这条交给 DeepSeek Harness',
  '/dsh on       本会话后续消息都由 DSH 接管',
  '/dsh off      交回主脑',
  '/dsh new      换一个新的 DSH 会话',
  '/dsh stop     中断当前任务',
  '/dsh status   看当前模式',
].join('\n');
