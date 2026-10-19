import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnswerMarkdown } from '../src/components/AnswerMarkdown';

const labels = { code: '代码', copy: '复制代码', copied: '已复制', failed: '复制失败' };
const render = (text: string) => renderToStaticMarkup(createElement(AnswerMarkdown, { text, labels }));

describe('formatted answers', () => {
  it('renders headings, emphasis, nested lists and inline code instead of Markdown markers', () => {
    const html = render('## 回答思路\n\n这是 **LeetCode 49**。\n\n- 使用 `HashMap`\n  - 按字母排序');
    expect(html).toContain('<h2>回答思路</h2>');
    expect(html).toContain('<strong>LeetCode 49</strong>');
    expect(html).toContain('<code>HashMap</code>');
    expect(html.match(/<ul>/g)).toHaveLength(2);
    expect(html).not.toContain('**');
  });

  it('preserves soft line breaks in existing plain-text answers', () => {
    expect(render('先给结论\n再说要点')).toContain('先给结论\n再说要点');
  });

  it('renders Java with highlighted syntax and a separate line-number gutter', () => {
    const html = render('```java\nclass Solution {\n    int answer = 42;\n}\n```');
    expect(html).toContain('answer-code-block');
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('hljs-number');
    expect(html).toContain('aria-hidden="true">1\n2\n3</pre>');
    expect(html).toContain('    ');
    expect(html).toContain('复制代码');
  });

  it('keeps Python indentation and internal blank lines intact', () => {
    const html = render('```python\ndef solve():\n    if True:\n        return 1\n\nsolve()\n```');
    expect(html).toContain('        ');
    expect(html).toContain('\n\n');
    expect(html).toContain('>1\n2\n3\n4\n5</pre>');
  });

  it('keeps a streamed, unclosed code fence in a code block', () => {
    const html = render('思路如下。\n\n```java\nclass Solution {\n    public int');
    expect(html).toContain('answer-code-block');
    expect(html).toContain('Solution');
    expect(html).not.toContain('```');
  });

  it('displays unlabeled and unsupported code as readable plain code blocks', () => {
    for (const language of ['', 'nonexistent-language']) {
      const html = render('```' + language + '\n    a < b\n```');
      expect(html).toContain('answer-code-block');
      expect(html).toContain('    a &lt; b');
    }
  });

  it('does not turn a short inline expression into a block', () => {
    const html = render('复杂度为 `O(n)`。');
    expect(html).toContain('<code>O(n)</code>');
    expect(html).not.toContain('answer-code-block');
  });

  it('renders GFM tables within a horizontal scrolling wrapper', () => {
    const html = render('| 方法 | 复杂度 |\n| --- | --- |\n| 哈希 | O(n) |');
    expect(html).toContain('answer-table-scroll');
    expect(html).toContain('<th>方法</th>');
  });

  it('never executes model-supplied HTML or loads remote answer images', () => {
    const html = render('<script>alert(1)</script>\n\n<img src="https://tracker.example/pixel" onerror="alert(1)">\n\n![remote](https://tracker.example/pixel)');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
  });

  it('escapes HTML-like code even when syntax highlighting is enabled', () => {
    const html = render('```java\nString x = "<img src=x onerror=alert(1)>";\n```');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('rejects javascript links', () => {
    expect(render('[打开](javascript:alert(1))')).not.toContain('href="javascript:');
  });

  it('falls back to plain escaped text for very large snippets', () => {
    const html = render('```java\n' + 'x'.repeat(50_001) + '\n```');
    expect(html).toContain('answer-code-block');
    expect(html).not.toContain('hljs-keyword');
  });
});

