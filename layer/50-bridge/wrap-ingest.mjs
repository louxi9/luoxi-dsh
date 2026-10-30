// 在 ingest 之后拦截：命令或粘性会话的消息交给桥，返回 accepted:false 让 宿主
// 的唤醒/LLM 链路整条跳过——同一时刻只有一个主脑。
import { holder } from './lib/holder.mjs';

export function wrapIngest(previous) {
  return (options) => {
    const instance = previous(options);
    const original = instance.ingestMessage.bind(instance);
    return {
      ...instance,
      async ingestMessage(args) {
        const result = await original(args);
        if (!result?.accepted || !holder.bridge) return result;
        try {
          if (await holder.bridge.handleMessage(result)) return { ...result, accepted: false, reason: 'luoxi-bridge' };
        } catch { /* 桥出问题不能影响正常聊天 */ }
        return result;
      },
    };
  };
}
