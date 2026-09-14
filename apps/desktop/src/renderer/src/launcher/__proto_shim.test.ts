import { describe, expect, it, vi } from 'vitest';

import { act, createElement, useEffect, useState } from 'react';

interface FakeNodeLike {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  ownerDocument: FakeDocumentLike | null;
  parentNode: FakeNodeLike | null;
  childNodes: FakeNodeLike[];
  firstChild: FakeNodeLike | null;
  lastChild: FakeNodeLike | null;
  nextSibling: FakeNodeLike | null;
  previousSibling: FakeNodeLike | null;
  textContent: string;
  appendChild(child: FakeNodeLike): FakeNodeLike;
  insertBefore(child: FakeNodeLike, ref: FakeNodeLike | null): FakeNodeLike;
  removeChild(child: FakeNodeLike): FakeNodeLike;
  addEventListener(): void;
  removeEventListener(): void;
  dispatchEvent(): boolean;
  getRootNode(): FakeNodeLike;
  contains(_other: unknown): boolean;
}

interface FakeElementLike extends FakeNodeLike {
  tagName: string;
  style: Record<string, unknown>;
  attributes: Record<string, string>;
  setAttribute(name: string, value: unknown): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  focus(): void;
  blur(): void;
  click(): void;
}

interface FakeDocumentLike extends FakeNodeLike {
  documentElement: FakeElementLike;
  body: FakeElementLike;
  head: FakeElementLike;
  activeElement: FakeElementLike | null;
  createElement(tag: string): FakeElementLike;
  createTextNode(text: string): FakeNodeLike;
  createComment(text: string): FakeNodeLike;
}

function installFakeDom(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.document !== 'undefined') {
    return;
  }

  function detachChild(node: FakeNodeLike): void {
    const parent = node.parentNode;
    if (parent === null) {
      return;
    }
    parent.removeChild(node);
  }

  class FakeNode implements FakeNodeLike {
    nodeType = 0;
    nodeName = '';
    nodeValue: string | null = null;
    ownerDocument: FakeDocumentLike | null = null;
    parentNode: FakeNodeLike | null = null;
    childNodes: FakeNodeLike[] = [];
    firstChild: FakeNodeLike | null = null;
    lastChild: FakeNodeLike | null = null;
    nextSibling: FakeNodeLike | null = null;
    previousSibling: FakeNodeLike | null = null;
    textContent = '';

    appendChild(child: FakeNodeLike): FakeNodeLike {
      detachChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      if (this.firstChild === null) {
        this.firstChild = child;
      }
      if (this.lastChild !== null) {
        this.lastChild.nextSibling = child;
        child.previousSibling = this.lastChild;
      }
      this.lastChild = child;
      return child;
    }

    insertBefore(child: FakeNodeLike, ref: FakeNodeLike | null): FakeNodeLike {
      detachChild(child);
      child.parentNode = this;
      if (ref === null) {
        return this.appendChild(child);
      }
      const index = this.childNodes.indexOf(ref);
      if (index < 0) {
        return this.appendChild(child);
      }
      this.childNodes.splice(index, 0, child);
      child.nextSibling = ref;
      child.previousSibling = ref.previousSibling;
      if (ref.previousSibling !== null) {
        ref.previousSibling.nextSibling = child;
      }
      ref.previousSibling = child;
      if (this.firstChild === ref) {
        this.firstChild = child;
      }
      return child;
    }

    removeChild(child: FakeNodeLike): FakeNodeLike {
      const index = this.childNodes.indexOf(child);
      if (index < 0) {
        return child;
      }
      this.childNodes.splice(index, 1);
      if (child.previousSibling !== null) {
        child.previousSibling.nextSibling = child.nextSibling;
      }
      if (child.nextSibling !== null) {
        child.nextSibling.previousSibling = child.previousSibling;
      }
      if (this.firstChild === child) {
        this.firstChild = child.nextSibling;
      }
      if (this.lastChild === child) {
        this.lastChild = child.previousSibling;
      }
      child.parentNode = null;
      child.previousSibling = null;
      child.nextSibling = null;
      return child;
    }

    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(): boolean {
      return false;
    }
    getRootNode(): FakeNodeLike {
      return this.ownerDocument ?? this;
    }
    contains(): boolean {
      return true;
    }
  }

  class FakeTextNode extends FakeNode {
    nodeType = 3;
    nodeName = '#text';
    nodeValue: string;
    textContent: string;

    constructor(text: string) {
      super();
      this.nodeValue = text;
      this.textContent = text;
    }
  }

  class FakeCommentNode extends FakeNode {
    nodeType = 8;
    nodeName = '#comment';
    nodeValue: string;
    textContent: string;

    constructor(text: string) {
      super();
      this.nodeValue = text;
      this.textContent = text;
    }
  }

  class FakeElement extends FakeNode implements FakeElementLike {
    nodeType = 1;
    nodeName: string;
    tagName: string;
    style: Record<string, unknown> = {};
    attributes: Record<string, string> = {};
    children: FakeNodeLike[] = [];

    constructor(tag: string) {
      super();
      this.nodeName = tag.toUpperCase();
      this.tagName = this.nodeName;
    }

    setAttribute(name: string, value: unknown): void {
      this.attributes[name] = String(value);
    }

    getAttribute(name: string): string | null {
      return this.attributes[name] ?? null;
    }

    removeAttribute(name: string): void {
      delete this.attributes[name];
    }

    hasAttribute(name: string): boolean {
      return name in this.attributes;
    }

    focus(): void {}
    blur(): void {}
    click(): void {}
  }

  const documentElement = new FakeElement('html');
  const fakeDocument = new FakeNode() as FakeDocumentLike;
  fakeDocument.nodeType = 9;
  fakeDocument.nodeName = '#document';
  fakeDocument.ownerDocument = null;
  fakeDocument.documentElement = documentElement;
  fakeDocument.body = new FakeElement('body');
  fakeDocument.head = new FakeElement('head');
  fakeDocument.activeElement = null;
  fakeDocument.createElement = (tag: string) => {
    const element = new FakeElement(tag);
    element.ownerDocument = fakeDocument;
    return element;
  };
  fakeDocument.createTextNode = (text: string) => {
    const node = new FakeTextNode(text);
    node.ownerDocument = fakeDocument;
    return node;
  };
  fakeDocument.createComment = (text: string) => {
    const node = new FakeCommentNode(text);
    node.ownerDocument = fakeDocument;
    return node;
  };
  documentElement.ownerDocument = fakeDocument;
  fakeDocument.body.ownerDocument = fakeDocument;
  fakeDocument.head.ownerDocument = fakeDocument;

  class FakeHTMLElement {}
  class FakeSVGElement {}
  class FakeHTMLIFrameElement {}

  const fakeWindow = {
    addEventListener(): void {},
    removeEventListener(): void {},
    dispatchEvent(): boolean {
      return false;
    },
    document: fakeDocument,
    HTMLIFrameElement: FakeHTMLIFrameElement,
    navigator: {
      userAgent: 'node',
      platform: 'linux',
    },
    devicePixelRatio: 1,
    innerWidth: 1024,
    innerHeight: 768,
  };

  const htmlElementNames = [
    'HTMLAnchorElement',
    'HTMLButtonElement',
    'HTMLCanvasElement',
    'HTMLDivElement',
    'HTMLFormElement',
    'HTMLHeadingElement',
    'HTMLIFrameElement',
    'HTMLImageElement',
    'HTMLLIElement',
    'HTMLLabelElement',
    'HTMLOptionElement',
    'HTMLParagraphElement',
    'HTMLSelectElement',
    'HTMLSpanElement',
    'HTMLTextAreaElement',
    'HTMLUListElement',
    'HTMLUnknownElement',
    'HTMLInputElement',
    'HTMLVideoElement',
    'HTMLAudioElement',
  ];

  g.window = fakeWindow;
  g.document = fakeDocument;
  g.HTMLElement = FakeHTMLElement;
  g.SVGElement = FakeSVGElement;
  for (const name of htmlElementNames) {
    g[name] = name === 'HTMLIFrameElement' ? FakeHTMLIFrameElement : FakeHTMLElement;
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;
}

describe('proto shim', () => {
  it('mounts a hook harness and runs debounced effects with fake timers', async () => {
    installFakeDom();

    const { createRoot } = await import('react-dom/client');
    const container = (globalThis as { document: FakeDocumentLike }).document.createElement('div');
    const root = createRoot(container);

    const calls: string[] = [];
    let setQ: ((query: string) => void) | undefined;

    function Harness(): null {
      const [query, setQueryState] = useState('');
      setQ = setQueryState;
      useEffect(() => {
        const timer = setTimeout(() => {
          calls.push(query);
        }, 150);
        return () => {
          clearTimeout(timer);
        };
      }, [query]);
      return null;
    }

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await act(async () => {
      root.render(createElement(Harness));
    });

    await act(async () => {
      setQ!('a');
    });

    vi.advanceTimersByTime(149);
    expect(calls).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(calls).toEqual(['a']);

    await act(async () => {
      setQ!('b');
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(calls).toEqual(['a', 'b']);

    await act(async () => {
      root.unmount();
    });

    vi.useRealTimers();
  });
});
