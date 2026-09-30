/**
 * Pi 扩展宿主的本地结构化类型。
 *
 * 与 `src/opencode-plugin/v2/types.ts` 的做法一致：只声明本扩展真正用到的
 * Pi `ExtensionAPI` 形状，而不是 import `@earendil-works/pi-coding-agent`。
 * 这样 SDK 对 Pi 不产生任何硬运行时/类型依赖，也不会在安装时被迫拉取宿主
 * 包；Pi 在运行时会传入真实对象，结构化类型保证接口兼容。
 *
 * 仅覆盖本扩展使用的事件与上下文；未知字段通过索引签名容忍。
 */

/** Pi 对话中的一条消息（本扩展只关心 role / content / toolCallId）。 */
export interface AgentMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  timestamp?: number;
  [key: string]: unknown;
}

/** 会话管理器：本扩展读取会话 ID 与工作目录。 */
export interface ExtensionSessionManager {
  getSessionId(): string;
  getCwd(): string;
  [key: string]: unknown;
}

/** 终端 UI：本扩展只用 notify 输出状态。 */
export interface ExtensionUi {
  notify(message: string, level?: string): void;
  [key: string]: unknown;
}

/** 事件处理器收到的上下文。 */
export interface ExtensionContext {
  ui: ExtensionUi;
  cwd: string;
  mode: string;
  hasUI: boolean;
  sessionManager: ExtensionSessionManager;
  [key: string]: unknown;
}

/** `context_with_system` 的返回值。 */
export interface ContextEventResult {
  messages?: AgentMessage[];
}

/** `tool_result` 中回填给模型的内容块（本扩展只改写文本块）。 */
export interface ToolResultContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** `tool_result` 处理器的返回值；省略字段保持原值。 */
export interface ToolResultEventResult {
  content?: ToolResultContent[];
  details?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

/** `message_end` 处理器的返回值。 */
export interface MessageEndEventResult {
  message?: AgentMessage;
}

export interface SessionStartEvent {
  type: "session_start";
}

export interface SessionShutdownEvent {
  type: "session_shutdown";
}

/** 请求发出前的完整消息列表（含 system 消息）。 */
export interface ContextWithSystemEvent {
  type: "context_with_system";
  messages: AgentMessage[];
}

/** 工具执行前的可写入参事件。 */
export interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: unknown;
  parentToolCallId?: string;
}

/** 工具执行完成后的结果事件。 */
export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: ToolResultContent[];
  details?: unknown;
  structuredContent?: unknown;
  isError: boolean;
  parentToolCallId?: string;
}

/** 一条消息结束的事件。 */
export interface MessageEndEvent {
  type: "message_end";
  message: AgentMessage;
}

/** 事件处理器签名；返回值语义由各事件决定。 */
export type ExtensionEventHandler<E, R = void> = (
  event: E,
  ctx: ExtensionContext,
) => Promise<R | void> | R | void;

/** 注册 `/` 命令的选项。 */
export interface RegisteredCommandOptions {
  description?: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

/**
 * Pi 传给扩展工厂的 API。
 *
 * 只声明本扩展使用的事件重载、命令注册与配置读取；Pi 的真实 API 是它的
 * 超集，因此运行时兼容。
 */
export interface ExtensionAPI {
  on(
    event: "session_start",
    handler: ExtensionEventHandler<SessionStartEvent>,
  ): () => void;
  on(
    event: "session_shutdown",
    handler: ExtensionEventHandler<SessionShutdownEvent>,
  ): () => void;
  on(
    event: "context_with_system",
    handler: ExtensionEventHandler<ContextWithSystemEvent, ContextEventResult>,
  ): () => void;
  on(
    event: "tool_call",
    handler: ExtensionEventHandler<ToolCallEvent>,
  ): () => void;
  on(
    event: "tool_result",
    handler: ExtensionEventHandler<ToolResultEvent, ToolResultEventResult | undefined>,
  ): () => void;
  on(
    event: "message_end",
    handler: ExtensionEventHandler<MessageEndEvent, MessageEndEventResult | undefined>,
  ): () => void;
  registerCommand(name: string, options: RegisteredCommandOptions): void;
  /** 返回合并后的 settings.json；本扩展读取约定键 `rehydra`。 */
  getSettings(): unknown;
}