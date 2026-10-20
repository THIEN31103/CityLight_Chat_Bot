import { Fragment, type ReactNode } from 'react';

/**
 * fill() for sentences with markup: "Tủ {label} · …" + { label: <b>…</b> } -> React nodes, so a dictionary keeps
 * whole sentences (word order differs between languages) while parts stay bold / monospace.
 */
export function rich(template: string, parts: Record<string, ReactNode>): ReactNode {
  return template.split(/(\{\w+\})/).map((p, i) => {
    const m = /^\{(\w+)\}$/.exec(p);
    return <Fragment key={i}>{m && m[1]! in parts ? parts[m[1]!] : p}</Fragment>;
  });
}
