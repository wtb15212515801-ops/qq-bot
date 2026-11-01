/**
 * 控制指令：界面通过 control.jsonl 下发的「改记忆 / 清上下文」操作。
 *
 * 从 pipeline.js 抽出来，是为了让主流程只管「收消息 → 回话」，
 * 这类由界面驱动的控制操作单独维护，也方便单测。
 */

export async function applyCommand(pl, cmd) {
  const c = String(cmd?.cmd || '');
  const key = String(cmd?.chat || '');

  switch (c) {
    case 'forgetFact': {
      const ok = pl.brain.removeFact(key, Number(cmd.index));
      pl.log.info(`界面：删除记忆（${key} #${cmd.index}）${ok ? '成功' : '失败'}`);
      return ok;
    }
    case 'clearFacts': {
      const n = pl.brain.clearFacts(key);
      pl.log.info(`界面：清空事实（${key}，${n} 条）`);
      return n;
    }
    case 'clearSummary': {
      pl.brain.clearSummary(key);
      pl.log.info(`界面：清空摘要（${key}）`);
      return true;
    }
    case 'resetGroup': {
      if (key === '*') {
        const n = pl.brain.resetAll();
        pl.store.save();
        pl.log.info(`界面：重置全部会话的记忆（${n} 个）`);
        return n;
      }
      pl.brain.resetGroup(key);
      pl.store.save();
      pl.log.info(`界面：重置整个会话的记忆（${key}）`);
      return true;
    }
    case 'clearContext': {
      let n = 0;
      if (key === '*') {
        for (const st of pl.states.values()) {
          n += st.messages.length;
          st.messages = [];
          st.members.clear();
        }
      } else {
        const st = pl.stateFor(key);
        n = st.messages.length;
        st.messages = [];
        st.members.clear();
      }
      pl.log.info(`界面：清空上下文（${key === '*' ? '全部会话' : key}，${n} 条）`);
      return n;
    }
    case 'pinFact': {
      const ok = pl.brain.togglePin(key, Number(cmd.index), cmd.pinned === true);
      pl.log.info(`界面：${cmd.pinned ? '置顶' : '取消置顶'}记忆（${key} #${cmd.index}）${ok ? '成功' : '失败'}`);
      return ok;
    }
    case 'setMood': {
      const v = pl.brain.setMood(key, cmd.value);
      pl.log.info(`界面：设定心情（${key} → ${v}）`);
      return v;
    }
    case 'reloadPersona': {
      pl.log.info('界面请求重载人设');
      return 'needs-restart';
    }
    default:
      pl.log.warn(`未知指令：${c}`);
      return false;
  }
}
