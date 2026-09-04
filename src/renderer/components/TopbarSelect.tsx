import { Check, ChevronDown } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";

export interface TopbarSelectOption {
  value: string;
  label: string;
}

interface TopbarSelectProps {
  className: string;
  label: string;
  value: string;
  options: TopbarSelectOption[];
  disabled: boolean;
  placeholder?: string;
  onChange: (value: string) => void;
}

export function nextOptionIndex(current: number, key: string, count: number): number {
  if (count === 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return Math.min(current + 1, count - 1);
  if (key === "ArrowUp") return Math.max(current - 1, 0);
  return current;
}

function useSelectDismissal(
  open: boolean,
  disabled: boolean,
  shellRef: RefObject<HTMLDivElement | null>,
  setOpen: Dispatch<SetStateAction<boolean>>,
): void {
  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent): void => {
      if (!shellRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [open, setOpen, shellRef]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled, setOpen]);
}

interface SelectMenuProps {
  id: string;
  label: string;
  value: string;
  options: TopbarSelectOption[];
  activeIndex: number;
  optionRefs: RefObject<Array<HTMLButtonElement | null>>;
  onSelect: (index: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void;
}

function SelectMenu(props: SelectMenuProps) {
  return (
    <div id={props.id} className="select-menu" role="listbox" aria-label={props.label}>
      {props.options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => { props.optionRefs.current[index] = element; }}
          className="select-option"
          type="button"
          role="option"
          aria-selected={option.value === props.value}
          title={option.label}
          tabIndex={index === props.activeIndex ? 0 : -1}
          onClick={() => props.onSelect(index)}
          onKeyDown={(event) => props.onKeyDown(event, index)}
        >
          <Check size={13} aria-hidden="true" />
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

export function TopbarSelect(props: TopbarSelectProps) {
  const listboxId = useId();
  const shellRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const selectedIndex = props.options.findIndex((option) => option.value === props.value);
  const selectedOption = props.options[selectedIndex];

  useSelectDismissal(open, props.disabled, shellRef, setOpen);

  const openMenu = (index = selectedIndex >= 0 ? selectedIndex : 0): void => {
    if (props.disabled || props.options.length === 0) return;
    setActiveIndex(index);
    setOpen(true);
    requestAnimationFrame(() => optionRefs.current[index]?.focus());
  };

  const closeMenu = (restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const selectOption = (index: number): void => {
    const option = props.options[index];
    if (!option) return;
    if (option.value !== props.value) props.onChange(option.value);
    closeMenu(true);
  };

  const moveOptionFocus = (key: string): void => {
    const nextIndex = nextOptionIndex(activeIndex, key, props.options.length);
    setActiveIndex(nextIndex);
    optionRefs.current[nextIndex]?.focus();
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const fallbackIndex = event.key === "ArrowUp" ? props.options.length - 1 : 0;
    openMenu(selectedIndex >= 0 ? selectedIndex : fallbackIndex);
  };

  const onOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      moveOptionFocus(event.key);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectOption(index);
    }
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  };

  return (
    <div ref={shellRef} className={`select-shell ${props.className} ${open ? "open" : ""}`} onBlur={onBlur}>
      <button
        ref={triggerRef}
        className="select-trigger"
        type="button"
        disabled={props.disabled}
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        title={selectedOption?.label}
        onClick={() => open ? closeMenu(false) : openMenu()}
        onKeyDown={onTriggerKeyDown}
      >
        <span>{selectedOption?.label ?? props.placeholder ?? ""}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <SelectMenu
          id={listboxId}
          label={props.label}
          value={props.value}
          options={props.options}
          activeIndex={activeIndex}
          optionRefs={optionRefs}
          onSelect={selectOption}
          onKeyDown={onOptionKeyDown}
        />
      )}
    </div>
  );
}
