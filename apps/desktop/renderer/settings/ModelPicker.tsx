// 模型候选：原生 <datalist> 的弹层跟随系统配色（深色系统下是黑框），也没法套上应用的玻璃样式，
// 所以改用 input + 自定义 listbox；输入仍然自由，候选只是提示，键盘和读屏语义按 combobox 处理。
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';

/** 估算弹层高度：放不下就翻到输入框上方，避免被设置面板的滚动区裁掉 */
const POPUP_HINT_HEIGHT = 250;

interface ModelPickerProps {
  id: string;
  value: string;
  options: readonly string[];
  placeholder: string;
  disabled?: boolean;
  invalid?: boolean;
  onChange(value: string): void;
  /** 候选没展开时按回车：交给调用方保存 */
  onCommit(): void;
}

export function ModelPicker({
  id,
  value,
  options,
  placeholder,
  disabled,
  invalid,
  onChange,
  onCommit,
}: ModelPickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<'below' | 'above'>('below');
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = `${id}-options`;

  const query = value.trim().toLowerCase();
  const matches = query
    ? options.filter((name) => name.toLowerCase().includes(query))
    : [...options];
  const expanded = open && matches.length > 0;

  useLayoutEffect(() => {
    if (!expanded) return;
    const box = wrap.current?.getBoundingClientRect();
    if (!box) return;
    const flip = box.bottom + POPUP_HINT_HEIGHT > window.innerHeight && box.top > POPUP_HINT_HEIGHT;
    setPlacement(flip ? 'above' : 'below');
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    // 点面板外收起；滚动和窗口缩放时候选跟着输入框走，不需要重算
    const onPointerDown = (event: PointerEvent): void => {
      if (wrap.current?.contains(event.target as Node)) return;
      setOpen(false);
      setActive(-1);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [expanded]);

  useEffect(() => {
    if (!expanded || active < 0) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, expanded, listId]);

  function close(): void {
    setOpen(false);
    setActive(-1);
  }

  function choose(name: string): void {
    onChange(name);
    close();
    input.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const last = matches.length - 1;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!expanded) {
        setOpen(true);
        setActive(last >= 0 ? 0 : -1);
      } else {
        setActive((index) => (index >= last ? 0 : index + 1));
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!expanded) {
        setOpen(true);
        setActive(last);
      } else {
        setActive((index) => (index <= 0 ? last : index - 1));
      }
      return;
    }
    if (event.key === 'Home' && expanded) {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === 'End' && expanded) {
      event.preventDefault();
      setActive(last);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (expanded && active >= 0 && matches[active]) choose(matches[active]);
      else {
        close();
        onCommit();
      }
      return;
    }
    if (event.key === 'Escape' && expanded) {
      // 只收起候选，别让窗口级 Escape 把整个设置面板关掉
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') close();
  }

  return (
    <div className={`model-field${expanded ? ' is-open' : ''}`} ref={wrap}>
      <input
        ref={input}
        id={id}
        className="field model-input"
        role="combobox"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onClick={() => {
          if (!expanded) {
            setOpen(true);
            setActive(-1);
          }
        }}
        onBlur={(event: FocusEvent<HTMLInputElement>) => {
          if (!wrap.current?.contains(event.relatedTarget)) close();
        }}
        onKeyDown={onKeyDown}
      />
      {expanded && (
        <ul
          className="model-options"
          id={listId}
          role="listbox"
          aria-label="可选的模型"
          data-placement={placement}
        >
          {matches.map((name, index) => (
            <li
              key={name}
              id={`${listId}-${index}`}
              className="model-option"
              role="option"
              aria-selected={name === value}
              data-active={index === active ? 'true' : undefined}
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => setActive(index)}
              onClick={() => choose(name)}
            >
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
