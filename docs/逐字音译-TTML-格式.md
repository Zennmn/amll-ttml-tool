# 逐字音译 TTML 格式

本项目的逐字音译保存在头部 `<transliterations>` 中，通过歌词行编号关联正文。每个音译单元使用带 `begin`、`end` 的 `<span>`。

“逐字”指一个带时间的歌词单元，可以是单个字、一个词或一个音节。

```xml
<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml"
    xmlns:ttm="http://www.w3.org/ns/ttml#metadata"
    xmlns:itunes="http://music.apple.com/lyric-ttml-internal"
    xml:lang="ja"
    itunes:timing="Word">
  <head>
    <metadata>
      <ttm:agent type="person" xml:id="v1"/>
      <iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal">
        <transliterations>
          <transliteration xml:lang="ja-Latn">
            <text for="L1">
              <span begin="0:01.000" end="0:01.700">kimi</span>
              <span begin="0:01.700" end="0:02.100">no</span>
              <span begin="0:02.100" end="0:03.000">na</span>
            </text>
          </transliteration>
        </transliterations>
      </iTunesMetadata>
    </metadata>
  </head>
  <body dur="0:03.000">
    <div begin="0:01.000" end="0:03.000">
      <p begin="0:01.000" end="0:03.000"
         itunes:key="L1" ttm:agent="v1">
        <span begin="0:01.000" end="0:01.700">君</span>
        <span begin="0:01.700" end="0:02.100">の</span>
        <span begin="0:02.100" end="0:03.000">名</span>
      </p>
    </div>
  </body>
</tt>
```

| 字段或节点 | 含义与要求 |
|---|---|
| `tt/@xml:lang` | 原文语言，例如 `ja`、`ko`、`zh-Hans`。 |
| `tt/@itunes:timing` | 逐字计时使用 `Word`。 |
| `p` | 一行原文歌词；`begin`、`end` 为该行时间范围。 |
| `p/@itunes:key` | 行编号，例如 `L1`、`L2`；每行唯一。 |
| `transliterations` | 音译轨道集合，位于 `head/metadata/iTunesMetadata` 下。 |
| `transliteration` | 一条音译语言轨道。 |
| `transliteration/@xml:lang` | 建议显式填写，例如 `ja-Latn`、`ko-Latn`、`zh-Latn`。 |
| `text/@for` | 对应原文行的 `itunes:key`，必须完全一致。 |
| `text/span` | 单个音译单元，文本为该单元读音。 |
| `span/@begin`、`span/@end` | 单元的开始、结束时间。原文与音译使用同一歌曲时间轴。 |
| `ttm:agent` | 演唱者引用；对应头部 `ttm:agent/@xml:id`，不用于音译配对。 |

书写规则：

1. 原文和音译按相同单元切分、按时间顺序排列，并使用相同的起止时间，以保证本项目导入后的对应关系。
2. 时间采用 `分:秒.毫秒`，例如 `0:01.700` 表示歌曲开始后的 `1700 ms`。
3. 多行音译在同一个 `<transliteration>` 下添加多个 `<text for="L…">`；正文增加对应 `<p>`。
4. 需要保留的词间空格写在 `<span>` 文本内部，例如 `<span begin="…" end="…">kimi </span>`。
5. `<iTunesMetadata>` 的默认命名空间必须按示例声明；其内部节点属于 Apple 扩展命名空间，正文节点属于 TTML 命名空间。
6. `<span ttm:role="x-roman">整行读音</span>` 表示整行音译，不能代替上述逐字时间结构。

背景和声的音译写在对应 `<text>` 内的 `x-bg` 容器中，正文同一行也需要有相应的背景和声：

```xml
<text for="L1">
  <span begin="0:01.000" end="0:01.700">kimi</span>
  <span ttm:role="x-bg">
    <span begin="0:01.500" end="0:02.000">a</span>
    <span begin="0:02.000" end="0:02.600">a</span>
  </span>
</text>
```

本项目兼容约束：每个原文单元只保留一个逐字音译字符串；不要依赖多个音译 `<span>` 自动合并到一个原文单元。保存为逐行计时 `Line` 会移除逐字时间；同时存在逐字音译与整行音译时，逐词导出优先使用逐字音译。
