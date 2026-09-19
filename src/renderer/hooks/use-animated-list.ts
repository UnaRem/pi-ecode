import { useEffect, useState, type AnimationEvent } from "react";

interface AnimatedItem {
  id: string;
}

export function mergeAnimatedItems<Item extends AnimatedItem>(items: Item[], current: Item[], leavingIds: ReadonlySet<string>): Item[] {
  const incoming = new Map(items.map((item) => [item.id, item]));
  const retained = current.flatMap((item) => {
    const replacement = incoming.get(item.id);
    if (replacement) {
      incoming.delete(item.id);
      return [replacement];
    }
    return leavingIds.has(item.id) ? [item] : [];
  });
  return [...retained, ...incoming.values()];
}

export function useAnimatedList<Item extends AnimatedItem>(items: Item[]) {
  const [renderedItems, setRenderedItems] = useState(items);
  const [leavingIds, setLeavingIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    setRenderedItems((current) => mergeAnimatedItems(items, current, leavingIds));
  }, [items, leavingIds]);

  const beginRemove = (id: string, remove: (id: string) => void): void => {
    setLeavingIds((current) => new Set(current).add(id));
    remove(id);
  };

  const finishRemove = (id: string, event: AnimationEvent<HTMLElement>): void => {
    if (event.animationName !== "attachment-leave") return;
    setLeavingIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setRenderedItems((current) => current.filter((item) => item.id !== id));
  };

  return { renderedItems, leavingIds, beginRemove, finishRemove };
}
