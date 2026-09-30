/**
 * Rehydra Pi Extension.
 *
 * 把宿主无关的 {@link scrubCore} 适配到 Pi 的 ExtensionAPI 上：
 * - 通过 `context_with_system` 在请求前匿名化 `AgentMessage[]`；
 * - 通过 `tool_call` 在工具执行前还原 PII 标签到原始值；
 * - 通过 `tool_result` 在结果回填给模型前脱敏真实 PII；
 * - 通过 `message_end` 改写最终回答的文本块，把 PII 标签还原为真值；
 * - 通过 `session_start` / `session_shutdown` 管理会话映射与匿名器生命周期。
 *
 * 该入口既可以通过 `pi install npm:@rehydra/pi-extension` 安装为 Pi 包，
 * 也可以作为 `pi -e ./dist/pi-extension/index.js` 直接加载。`pi.install`
 * 自动识别 `package.json` 的 `pi.extensions` 字段。
 */
import type { ExtensionAPI } from "./host-types.js";

import { createRehydraPiExtension } from "./extension.js";

/**
 * The default Extension factory exported to Pi's extension loader.
 *
 * Pi loads the extension as `export default function (pi: ExtensionAPI)` so
 * that the host can `await pi.install()` semantics work uniformly. The
 * factory builds the anonymizer lazily on `session_start` and disposes it on
 * `session_shutdown`, keeping state scoped to a single session.
 */
export default function rehydraPiExtension(pi: ExtensionAPI): void {
  return createRehydraPiExtension(pi);
}

/** 命名导出，便于高级用户组合写法：`import { createRehydraPiExtension } from "..."` */
export { createRehydraPiExtension } from "./extension.js";
export type { RehydraPiExtensionOptions } from "./options.js";