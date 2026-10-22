import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/core';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';

for (const [name, syntax] of Object.entries({ java, javascript, typescript, python, c, cpp, csharp, go, rust, json, bash, sql, xml, css })) {
  hljs.registerLanguage(name, syntax);
}

export interface CodeLabels {
  code: string;
  copy: string;
  copied: string;
  failed: string;
}

function CodeBlock({ code, language, labels }: { code: string; language: string; labels: CodeLabels }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Markdown parsers add one terminal newline to code blocks. Keep internal blank lines.
  const display = code.replace(/\n$/, '');
  const highlighted = useMemo(() => {
    // Do not guess the language or repeatedly highlight huge streamed snippets.
    if (!language || !hljs.getLanguage(language) || display.length > 50_000) return undefined;
    try { return hljs.highlight(display, { language, ignoreIllegals: true }).value; }
    catch { return undefined; }
  }, [display, language]);

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await window.mc.writeClipboardText(code);
      setCopyState('copied');
    } catch { setCopyState('failed'); }
    timer.current = setTimeout(() => setCopyState('idle'), 2000);
  };

  return (
    <div className="answer-code-block">
      <div className="answer-code-head">
        <span className="answer-code-language">{language || labels.code}</span>
        <button className="btn btn-sm" onClick={() => void copy()} aria-live="polite">
          {copyState === 'idle' ? labels.copy : copyState === 'copied' ? labels.copied : labels.failed}
        </button>
      </div>
      <div className="answer-code-scroll" tabIndex={0} role="region" aria-label={language || labels.code}>
        <pre className="answer-code-gutter" aria-hidden="true">{display.split('\n').map((_, i) => i + 1).join('\n')}</pre>
        <pre className="answer-code-content"><code className="hljs" {...(highlighted === undefined
          ? { children: display }
          // highlight.js escapes source text; raw model HTML never reaches this sink.
          : { dangerouslySetInnerHTML: { __html: highlighted } })} /></pre>
      </div>
    </div>
  );
}

/** Render stored and streamed Markdown without executing HTML or loading remote images. */
export const AnswerMarkdown = memo(function AnswerMarkdown({ text, labels }: { text: string; labels: CodeLabels }) {
  const components = useMemo<Components>(() => ({
    pre({ node, children }) {
      const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code');
      if (!code || code.type !== 'element') return <pre>{children}</pre>;
      const classes = Array.isArray(code.properties.className) ? code.properties.className.join(' ') : String(code.properties.className ?? '');
      const language = /(?:^|\s)language-([^\s]+)/.exec(classes)?.[1].toLowerCase() ?? '';
      const value = code.children.map((child) => child.type === 'text' ? child.value : '').join('');
      return <CodeBlock code={value} language={language} labels={labels} />;
    },
    table: ({ children }) => <div className="answer-table-scroll"><table>{children}</table></div>,
    // Preserve the app's existing external-link policy and keep navigation out of the overlay.
    a: ({ href, children }) => <a href={href} onClick={(event) => {
      event.preventDefault();
      if (href) void window.mc.openExternal(href);
    }}>{children}</a>,
    img: () => null,
  }), [labels]);

  return <div className="answer-markdown"><Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml>{text}</Markdown></div>;
});
