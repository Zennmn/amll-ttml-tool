<div align=center>

<img src="./public/logo.svg" align="center" width="256">

# Apple Music-like Lyrics TTML Tool

一个全新的逐词歌词编辑器！针对 [Apple Music-like Lyrics 生态](https://github.com/amll-dev/applemusic-like-lyrics)制作！

<img width="1312" alt="image" src="https://github.com/user-attachments/assets/4db81b29-df0c-4f6e-819a-3b956b28247c">
<img width="1312" alt="image" src="https://github.com/user-attachments/assets/929eefee-ebda-43db-ad04-c0f099077053">
<img width="1312" alt="image" src="https://github.com/user-attachments/assets/7c80902e-45a9-42ae-b980-f5500069acb8">

</div>

## 使用

> [!WARNING]
> 本工具不建议移动手机或小尺寸电子设备使用，操作会非常繁琐！

你可以通过访问 [`https://amll-ttml-tool.stevexmh.net/`](https://amll-ttml-tool.stevexmh.net/)来使用本工具的在线版本。

欢迎访问[ test 分支](https://amll-ttml-tool-test.vercel.app/)来体验最新的功能和最新的 BUG！

也可以使用 Github Action 构建的 Tauri 桌面版本，具体见 [Github Action 构建 Tauri 桌面版本](https://github.com/amll-dev/amll-ttml-tool/actions/workflows/build-desktop.yaml)。

## 编辑器功能

- 基本输入、编辑、打轴功能
- 读取保存 TTML 格式歌词
- 配置歌词行行为（背景歌词、对唱歌词等）
- 配置歌词文件元数据（名称，作者，网易云音乐 ID 等）
- 粘贴 Apple Music 歌曲链接，预览并导入歌名、歌手、专辑和 Apple Music ID
- 拆分/组合/移动单词
- LRC/ESLyric/YRC/QRC/Lyricify Syllable 等歌词文件格式的导入以及部分格式的导出
- 支持带有特殊标识符的纯文本导入歌词
- 可配置的快捷键

## 在线歌词源导入

### 本地桌面版

日常使用可直接双击桌面的 **“AMLL TTML Tool 本地版”** 快捷方式、项目根目录的 **`启动桌面版AMLL.cmd`**，或 `desktop-app/AMLL TTML Tool.exe`。页面与歌词源已打包在程序内，无需运行网页启动脚本，也无需 Node.js、PNPM 或 Rust。免安装目录中的 `WebView2Loader.dll` 请与程序一同保留；电脑需要已安装 Microsoft Edge WebView2 Runtime。

`desktop-app` 内也提供 `-setup.exe` 安装包。此定制版使用独立的应用标识，停用上游自动更新。多歌词源、当前歌词整理、缺失翻译补齐和 TTML 导出设置均可使用。网页版和桌面版的偏好设置、自动保存记录相互独立；请在网页版保存已有歌词，再从桌面版打开文件。

重新构建：`pnpm desktop:build`；加 `-CreateShortcut` 可创建或更新桌面入口。脚本使用 PowerShell 7 和本机 Rust/C++ 工具链，支持此电脑已有的 GNU/LLVM 环境。原始 Tauri 配置保持独立，本地版使用 `src-tauri/tauri.local.conf.json`，网页构建目录不会被桌面构建覆盖。

### 本地网页版

本机使用请双击项目根目录的 **`启动AMLL.cmd`**，它会准备并启动本地版，然后自动打开浏览器。也可以在项目目录执行 `pnpm local`。关闭浏览器后服务仍在后台运行，双击 **`停止AMLL.cmd`** 或运行 `pnpm local:stop` 可停止。

首次运行会按需构建，日常再次打开会复用已有程序；修改源码后请先停止再启动。服务只监听本机 `127.0.0.1`，默认地址为 `http://127.0.0.1:5173`。请保留项目目录中的 `dist` 和 `lyrics-service/target/debug`，启动入口会使用这些文件。

从“文件 → 导入歌词 → 从在线歌词源导入”打开搜索窗口。本地网页版和桌面版支持网易云音乐、QQ 音乐、酷狗音乐和 LRCLIB；纯静态网页版可使用 LRCLIB。`pnpm dev` 只启动前端开发服务器，本机日常使用请选择上述启动入口。

加载音频后打开窗口，会优先使用音频标签中的歌名、歌手默认搜索；`track` 曲目编号不作为歌名。缺少歌名标签时，直接使用去掉扩展名后的完整文件名，不拆分、不去编号，也不追加歌手，例如 `06 - West Coast.m4a` 会搜索 `06 - West Coast`。可以启用或关闭各来源、筛选结果、加载更多，并在预览后选择是否导入翻译、音译。酷狗支持选择歌词版本。逐字歌词保留来源词轴，逐行和纯文本歌词仍可继续手动打轴。

各来源独立处理超时和错误。某一来源不可用时，其他结果仍能使用；获取或解析失败不会替换当前歌词，导入保留已加载音频。本地版由同一个本机服务提供页面和歌词接口，桌面版使用原生请求通道，两者复用来源与解密代码。来源接口的可用性取决于对应服务。

来源请求、签名、解密和 KRC 格式适配参考并移植自 [LDDC](https://github.com/chenmozhijin/LDDC)（Copyright 2024–2025 沉默の金，GPL-3.0-only），保留在相应源码中的署名。

验证多源请求隔离和格式适配：`pnpm test:online-lyrics`。应用与测试类型检查分别使用 `pnpm exec tsc -b`、`pnpm exec tsc -p tsconfig.test.json`。

本地服务开发与测试：`cargo test --manifest-path lyrics-service/Cargo.toml`。Windows 启动脚本要求 PowerShell 7；首次构建需要 Node.js、PNPM 和 Rust，已有构建产物可直接启动。需要手动指定端口时可使用 `pwsh -File scripts/start-local.ps1 -Port 5174`。

## 打轴时显示发音

切换到“打轴”，在顶部“显示选项 → 发音显示”中选择“原文在上”或“罗马音在上”，即可在同一个音节格中同时显示较大的主文本与较小的辅助文本；选择“关闭”恢复仅显示原文。选择会自动保存，无需先打开逐字音译编辑栏。

即使歌词没有任何音译，也会使用内置日语词典按整句上下文自动识别汉字、假名读音，再对应到现有音节格显示罗马音。词典随程序提供，运行时不需要联网或登录；首次使用会在后台加载，顶部显示进度，失败时可点击“重试”。

已有逐字音译优先，其次使用可对齐的整行音译，最后补充自动识别的读音。可在编辑模式的逐字音译栏填写读音以校正特殊唱法。注音细分单元沿用各自的时间和选择位置，不复制整词读音到每一个子单元。

自动生成的读音仅用于显示，不改歌词、逐字时间、翻译或已保存的音译数据，也不影响 TTML 导出和撤销记录。时间戳、高亮与打轴快捷键继续作用于原来的音节。验证词典、对齐和后台请求：`pnpm test:japanese-reading`。

日语识别采用 [kuromoji.js](https://github.com/takuyaa/kuromoji.js) 与其 IPADIC 词典，相关 Apache 2.0 和词典版权声明一同打包。开发时通过 `pnpm prepare:japanese` 从已安装依赖准备词典；开发及构建命令会自动执行此步骤。

## Apple Music 元数据导入

打开元数据编辑器，点击左侧“从 Apple Music 导入”，粘贴歌曲链接并获取预览。支持歌曲链接和包含 `?i=歌曲ID` 的专辑分享链接，使用链接中的商店地区查询，无需登录或填写 Token。

可选择导入歌名、歌手、专辑和 Apple Music ID。默认只勾选当前为空的字段；勾选已有字段会替换该字段的值，未勾选的内容保留。点击“导入所选字段”才会写入，整次操作可用 `Ctrl+Z` 撤销。歌词、时间轴、翻译和词曲作者等其他元数据不受影响。预览中的发行日期、时长仅供核对歌曲版本。

基础查询不提供 ISRC 和完整词曲署名；没有获取到的字段不会清空已有信息。仅含专辑 ID 的链接需要先在 Apple Music 中选择具体歌曲。地区不可用、下架、限流或网络失败时可修改链接或稍后重试。

验证链接解析、请求取消、字段选择、撤销与数据保留：`pnpm test:apple-music`。

## TTML 导出格式

保存文件、复制 TTML 和提交歌词共用导出格式：包含 UTF-8 XML 声明，根元素明确写入逐词 `itunes:timing="Word"` 或逐行 `itunes:timing="Line"`，时间统一为 `分:秒.毫秒`（如 `0:03.416`）。导入 TTML 时保留原文语言，未知语言写为 `xml:lang="und"`。

直接打开“文件”菜单，在与“保存 TTML 文件”同级的“TTML 计时模式”和“原文语言”中切换即可。菜单显示当前选中值；计时支持自动、逐词、逐行，语言支持跟随原文件、常用语言和自定义语言代码。选择会自动记住，并用于保存、复制和提交；选择逐行会只导出行时间，编辑器里的逐词时间仍保留。原文语言选择不改变翻译语言。“设置 → 常规 → 导出”仍可调整相同的默认选项。

默认 Apple Music 样式将逐行翻译写入 `<head>` 的 `iTunesMetadata`，翻译标为 `type="subtitle"`，通过 `for="L1"` 等行标识关联正文。设置中的 AMLL 样式继续使用行内翻译。演唱者编号和段落划分沿用现有编辑器行为。

验证导出声明、时间和内容保留：`pnpm test:ttml-export`。

## TTML 歌词整理

从“工具 → 整理当前歌词...”打开，勾选“合并独立标点”和“圆括号内歌词转为背景和声”，查看预计整理数量后点击“应用到当前歌词”。编辑区会直接更新：标点合并到前词，圆括号内的词提取到背景歌词行。整次操作可用 `Ctrl+Z` 撤销，完成后按平常方式保存工程。

整理直接处理当前工程数据，保留原词时间、逐字音译、注音和编辑属性；独立标点并入前词时不延长前词时间。仅成对的英文圆括号 `()`、中文圆括号 `（）` 内歌词会去掉圆括号并标为背景和声。`[]`、`【】`、`{}`、`〔〕`、`「」`、`『』` 等其他括号不触发和声转换；不成对的圆括号和遮蔽星号保留。可只启用其中一项，整个过程在本机完成。

“工具 → 用原文补齐缺失翻译”会把当前工程没有翻译的主歌词行，用原文原样填入翻译栏，例如 `ohh---` 的翻译也填 `ohh---`。已有翻译不会覆盖，空白歌词行及背景和声行会跳过；整次操作可用 `Ctrl+Z` 撤销。

验证整理和补齐翻译规则：`pnpm test:ttml-cleanup`。

“工具 → 合并过短音节...”按实际持续时间合并 CJK 歌词单元，默认处理小于 `100ms` 的已打轴单元，可调整阈值、选择自动/优先向前/优先向后，以及应用行范围。自动模式优先合并时间间隔更近的邻字，间隔相同时选择较短的邻字；指定方向不可用时尝试另一侧。合并保持文字顺序，起止时间覆盖合并前的单元，保留翻译、音译、注音和行属性，整次可用 `Ctrl+Z` 撤销。

合并只发生在同一行相邻的 CJK 单元之间，不跨空格、独立标点、其他语言或超过当前阈值的停顿；未打轴、零时长和无效时间会跳过。此功能与原有“平滑时间轴”的百分比阈值分别使用。验证：`pnpm test:short-syllables`。

更新后如果未看到整理菜单，请先保存当前工程，关闭本地版的旧标签页后重新打开，让页面使用新版本缓存。

## 开发构建

本工具构建可能相对比较复杂，如果文字描述太过繁杂的话可以直接参考 [`build-desktop.yaml`](.github/workflows/build-desktop.yaml) 工作流的步骤自行进行。

首先，本项目仅可使用 PNPM，请确保你已经安装好了 PNPM 包管理器！

然后克隆本仓库，然后在仓库文件夹下执行构建：

```bash
pnpm i # 安装依赖
pnpm dev # 开启开发服务器
pnpm build # 构建网页版本
pnpm tauri dev # 开启 Tauri 桌面版本开发环境
pnpm tauri build # 构建 Tauri 桌面版本
```

## 贡献

欢迎各种积极的代码/翻译贡献！也欢迎积极提交各种议题和建议！

如果想要提供新的语言翻译，可以参考 [`./src/i18n/index.ts`](./src/i18n/index.ts) 和 [`./locales/zh-CN/translation.json`](./locales/zh-CN/translation.json) 哦！
