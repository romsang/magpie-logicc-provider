# magpie-logicc-provider

> 把 [Logicc](https://app.logicc.com) 接入 [magpie](https://usemagpie.ai) / OpenCode——用你浏览器里已经在付的那个订阅。

[English](README.md) · 简体中文

---

Logicc 确实有官方的 OpenAI 兼容 API，但 key 是人工开通的：要发邮件过去，报公司、用途、需要的模型。没有自助页面。这个插件走另一条路——用你已经付费的网页端，按它前端自己的方式跟它说话。

没有 sidecar 进程，不占本地端口。OpenAI 请求形状到 Logicc 形状的改写，发生在 `auth.loader` 交回的 `fetch` 里，和 WorkBuddy、Tabbit 两个插件处理自家协议是同一个手法。

- **零依赖**——只用 Node 内置模块
- **真实模型表**——你账号实际能用的那些，不是硬编码列表
- **客户端工具调用**——走 JSON 信封，因为 Logicc 的聊天接口不接受工具定义
- **自动续期**——session JWT 只有 60 秒生命期，插件按需续期并把轮换的 cookie 存回去

## 目录

- [为什么需要它](#为什么需要它)
- [安装](#安装)
- [登录](#登录)
- [配置](#配置)
- [工作原理](#工作原理)
- [实测行为](#实测行为)
- [已知限制](#已知限制)
- [开发](#开发)
- [免责](#免责)
- [License](#license)

## 为什么需要它

Logicc 在 `https://api.logicc.cloud/v1` 上有官方网关，文档在 [help.logicc.com](https://help.logicc.com/docs/api/logicc-api-dokumentation)。开通方式是：

> 给他们团队发邮件申请 API key，主题写 `API`，说明公司、用途、需要的模型、预期请求量、目标环境。

对有成套采购流程的公司没问题，但对只是付了月费、想把它接进 agent 的人没用。所以这个插件走另一条路——网页端已经在用的那条：

```
登录   →  Clerk `__client` cookie
模型表 →  GET  app.logicc.com/api/models
一轮   →  POST app.logicc.com/api/chats  →  POST /api/chats/<id>   （SSE, AI SDK v6）
```

如果你**能**拿到官方 key，那就用官方：更干净，而且根本不需要插件——在 magpie 设置里把 `https://api.logicc.cloud/v1` 加成一个 OpenAI 兼容的 provider，填上 key，模型列表从同一个地址加 `/models` 拉。

## 安装

需要 **Node.js 22+** 和 magpie。

直接从 GitHub 安装——不需要 npm 账号，也不用先发到 registry：

```bash
magpie plugin add github:romsang/magpie-logicc-provider
```

或从本地克隆安装：

```bash
git clone https://github.com/romsang/magpie-logicc-provider.git
magpie plugin add "$(pwd)/magpie-logicc-provider"
```

**必须用绝对路径。** 相对路径 `.` 会按 magpie 的工作目录解析，不是你的，然后报 `its package names no file to load`。

**装完重启 magpie。** 它在启动时构建订阅表，新插件的登录方式要重启后才认得。

验证：

```bash
magpie plugin list          # → logicc (Logicc, N models)
magpie provider test logicc # → ✓ chat  4000 ms · <model>
```

## 登录

看到几种登录方式，取决于插件进程能不能读 Chrome 的 cookie 库。多数情况下不能——见[已知限制](#已知限制)——所以通常只有一个。

### 粘贴 `__client` Cookie（到处都能用）

这是实际可用的那条路，也是多数人会用的一条。整个操作大概两分钟。

#### 第 1 步：在 Chrome 里打开 Logicc

打开 `https://app.logicc.com`，确认**是已登录状态**——右上角/侧栏能看到你的账号名。

> 必须用**你登录 Logicc 的那个浏览器**。换一个浏览器、或者无痕窗口，cookie 不在那里。

#### 第 2 步：打开开发者工具（DevTools）

在**那个页面上**，用下面任意一种方式：

| 方式 | 操作 |
|---|---|
| 快捷键（最快） | **`⌥⌘I`** —— 也就是 Option + Command + I |
| 右键 | 页面任意位置右键 → **检查**（Inspect） |
| 菜单栏 | **查看** → **开发者** → **开发者工具** |
| 只开控制台 | **`⌥⌘J`** |

> 中文版 Chrome 里 `⌥⌘I` 同样有效，不用怕菜单名字不一样。

打开后，DevTools 会占掉浏览器右侧或下方的半边。如果挤在一起看不清，可以把 DevTools 拖出来单独成窗口。

#### 第 3 步：切到 Application 面板

在 DevTools 顶部的标签栏里找 **Application**（中文版叫 **应用** 或 **应用程序**）。

> 如果窗口太窄，标签会被折叠成 **`»`** 这个符号，点开里面找。
> 如果连 `»` 都没有，先把 DevTools 窗口拉宽一点。

#### 第 4 步：找到 Cookies

在左侧栏往下滚，找到 **Storage（存储）** 分组，展开里面的 **Cookies**。

展开后会列出几个域名，点 **`https://clerk.logicc.com`**。

> ⚠️ 这一条最容易错：**必须是 `clerk.logicc.com`，不是 `app.logicc.com`**。
> 两个域名下都有 cookie，但 `__client` 只在 clerk 那个下面。

#### 第 5 步：复制 `__client` 的值

右边会出现一张表。在 **Name** 列里找到 **`__client`**，然后双击它那一行 **Value** 列（最后一列）里的内容，全选，复制。

这个值很长——**500 多个字符**，看起来像乱码，通常以 `eyJ...` 开头。这是正常的。

> ⚠️ 别拿错行。这几个名字很容易混：
>
> | Name | 要不要 |
> |---|---|
> | **`__client`** | ✅ **要这个** |
> | `__session` | ❌ 不要，这是另一个凭据 |
> | `__client_uat` / `__client_uat_xxx` | ❌ 不要，这是时间戳 |
> | `clerk_active_context` | ❌ 不要 |
>
> 只有 `__client`，没有后缀、没有 `uat`。

#### 第 6 步：粘进 magpie

回到 magpie，在 Logicc 的登录框里粘贴，保存。

**不用填 session id。** 插件会拿这个 cookie 去 Clerk 的 `/v1/client` 自己查。

保存后应该立刻显示账号已登录、并列出模型（11 个左右）。如果显示登录了但没有模型，点一下刷新。

---

#### 为什么必须手动复制

`__client` 是 **`httpOnly`** 的——这是浏览器的一个安全机制，意味着**任何页面脚本都读不到它**，包括你在 Console 里敲 `document.cookie`，也包括插件想直接从页面取。

所以它只能从 DevTools 的 cookie 表格里看。这也是为什么「浏览器一键登录」在部分环境下用不了（见[已知限制](#已知限制)）。

#### 复制后还是不成功？

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 复制出来很短，不是 `eyJ` 开头 | 拿错行了，或者复制的是 `__client_uat` | 回第 5 步，确认 Name 就是 `__client` |
| 提示凭据无效 | 复制时漏了开头/结尾的字符 | 全选重新复制，注意别漏首尾 |
| 提示已过期 | 你在 Logicc 网页上退出登录过 | 重新登录 Logicc，再取一次新的 |
| 保存成功但没有模型 | 该账号还没开通模型权限 | 登录 Logicc 网页确认能看到模型列表 |

---

#### 这个值安全吗

- 它等同于你在 Logicc 网页上的登录状态，**别发到公开地方**（issue、截图、聊天群）
- 存在你本机的 `~/.config/magpie/plugin-auth.json` 里，权限 `600`（只有你自己能读）
- 你在 Logicc 网页上点「退出登录」，它就失效，需要重新取

> 报 bug 时**不要**贴出这个值。说「尾号 `…Zeg`」就够了——最后三位足以定位是哪个账号。

### 浏览器登录（cookie 库可读时才有）

点 **Sign in**，Logicc 的登录页在你的浏览器里打开。在那里登录，magpie 自己接住账号。

这需要读浏览器 cookie 库的权限，而 macOS 是按应用授予的。从终端调用可以，magpie 以 `launchd` 后台服务运行时一般不行。**不可用时插件不提供这个入口**——而不是让你走完自己那部分再失败。

## 配置

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `LOGICC_CONTEXT` | `200000` | `contextWindow` 档位未知时的兜底上下文长度 |
| `LOGICC_OUTPUT` | `32000` | 上报给模型的最大输出 token |
| `MAGPIE_LOGIC_SIGNIN_DEBUG` | （未设） | 登录诊断日志的追加路径 |

magpie 界面里的插件选项：

- **客户端工具走 JSON 信封**——默认开。关掉的话，声明了工具的请求直接报错，而不是被改写。

## 工作原理

### 登录

`__client` 是唯一长期凭据。它去 `clerk.logicc.com/v1/client/sessions/<sid>/tokens` 换 session JWT，而那个 JWT 只有**约 60 秒**——所以是缓存后按需续期，不是每次请求都换。Clerk 有时会轮换 `__client`，新值必须存回去，否则下次续期就失败。

`auth.refresh` 在过期前主动续，所以账号闲着也不会失效。

### 一轮对话

Logicc 的聊天接口收一个 `prompt` 字符串，不是消息数组，所以一轮要写成文本：

```
[system]
You are a helpful assistant.

[user]
Summarise this file.

[assistant]

[Tool calls]
[{"id":"c1","function":{"name":"read"}}]

[Tool result: c1]
the file contents
```

**对话本身不保留历史。** 对真实账号实测：往同一个 chat id 发两轮，它们互不相识——第二轮看不到第一轮。所以每轮都发完整历史，并且新建 chat。顺带的好处是对话不会在上游留第二份副本，Logicc 那边也就不会给它存储和起标题。

### 工具调用

Logicc 的模型没有客户端工具通道，所以声明了工具的请求会被改写成"用一个 JSON 信封作答"的指令：

```json
{"content": "text for the user or null", "tool_calls": [{"name": "…", "arguments": {}}]}
```

回复再解析回 OpenAI 的 `tool_calls`，带 `finish_reason: "tool_calls"`。实测可用：`calculate({"expression":"6 * 7"})`。

### 流式

Logicc 返回 AI SDK v6 事件（`text-delta`、`tool-input-start`、`tool-input-delta`、`finish`……）。`src/sse.mjs` 把它们折成文本、推理、工具调用和用量，插件再以 `chat.completion.chunk` 行重新发出。

## 实测行为

都是在真实账号上测的，不是从文档推断。每一条都影响了代码：

| 发现 | 后果 |
|---|---|
| `__client` 是 `httpOnly` | 任何页面脚本都读不到。session id 从 cookie 里查，不问用户 |
| Session JWT 只有约 60 秒 | 按需续期；轮换的 cookie 会持久化 |
| **同一个 chat 不记得自己的轮次** | 每轮发完整历史，不复用 chat |
| `finish` 不带 `finishReason`、不带 token 数；`/api/usage`、`/api/me`、`/api/credits` 全是 404 | 用量报 `null`，绝不编数字 |
| 不输出 reasoning 增量，哪怕模型标着 `always-reasoning-configurable` | `reasoning: false`，免得 agent 干等永远不来的 token |
| `contextWindow` 是档位（`gigantic`、`medium`），不是数字 | 映射成已知大小：`gigantic` → 1,000,000 |
| prompt 看起来像在访问主机文件时，返回**空流**——连 `start` 都没有 | 当成错误报出去，绝不当作"模型没话说" |

## 已知限制

**浏览器登录不通用。** 读 Chrome 的 cookie 库意味着用 macOS 存在登录钥匙串里的密钥去解密，而 macOS 是按应用门控浏览器 cookie 库的。在 macOS 26 上实测：

| 谁在读 | 直接读文件 | 经 `osascript do shell script` |
|---|---|---|
| 终端 / 脚本 | ✅ | ✅ |
| `launchd` 下的 magpie 插件宿主 | ❌ `EPERM` | ❌ 静默拒绝（TCC 报 `authorization denied`） |

`launchd` 拉起的后台服务没有 GUI 会话，拿不到「自动化」授权，所以拒绝是静默的——不弹窗、不提示。插件没有任何办法、也不应该去绕过它。这就是粘贴方式存在的原因，也是浏览器方式在无法完成时被隐藏的原因。

**其他限制：**

- 登录是浏览器会话，不是 API 契约。Logicc 改前端或者吊销会话，就得重粘。
- 不报 token 用量和花费——见上表。
- 只处理文本。图片在 prompt 里写成 `[image]`，不会被发送。
- `maxConcurrency: 1`——Logicc 按账号串行。

## 开发

```bash
npm test                          # 35 个单元测试，不联网
node test/live.e2e.mjs <文件>      # 真实账号端到端，会花额度
```

`live.e2e.mjs` 接收一个装着 `__client` 值的文件，覆盖：配置注入、真实模型表、流式回答、历史延续、工具调用、受限 prompt 报错。

目录结构：

```
index.mjs           插件本体：config、auth methods、provider.models、loader
opencode.mjs        magpie 和 OpenCode 1.x 加载的导出面
src/logicc.mjs      跟 Logicc 说话：cookie、JWT 续期、chat、模型
src/signin.mjs      浏览器登录：oauth 契约、Chrome cookie、TCC 探测
src/sse.mjs         AI SDK v6 事件流 → 文本、推理、工具调用
src/models.mjs      模型表 → magpie 的模型行
```

## 免责

与 Logicc GmbH 无关。这是一个非官方客户端，通过网页端在用的同一接口，使用你已有的订阅。Logicc 的服务条款未必欢迎这种做法，账号也可能因为异常流量被限速或封禁。请用你承受得起损失的账号。

要长期稳定，走官方 key——申请方式见 [Logicc 的 API 文档](https://help.logicc.com/docs/api/logicc-api-dokumentation)。

按 MIT 许可原样提供，不附带任何担保。

## License

[MIT](LICENSE)
