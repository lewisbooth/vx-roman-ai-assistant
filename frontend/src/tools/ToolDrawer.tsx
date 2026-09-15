import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toolDefinitions, type AssistantTools, type ToolName } from ".";

export function ToolDrawer({
  tools,
  children,
}: {
  tools: AssistantTools;
  children?: ReactNode;
}) {
  const id = useId();
  const [name, setName] = useState<ToolName>("search_products");
  const [input, setInput] = useState(
    JSON.stringify(toolDefinitions[0].example, null, 2),
  );
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  const running = useRef(false);
  const definition = toolDefinitions.find((tool) => tool.name === name)!;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function run() {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setError(undefined);
    setResult(undefined);
    try {
      let args: unknown;
      try {
        args = JSON.parse(input);
      } catch {
        throw new Error("Arguments must be valid JSON.");
      }
      const output = await tools.execute(name, args);
      if (mounted.current) setResult(JSON.stringify(output, null, 2));
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "The tool failed.");
    } finally {
      running.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return (
    <details className="roman-tools font-sans text-[13px] leading-[1.5]">
      <summary className="cursor-pointer py-[8px] text-[16px]">
        Developer tools
      </summary>
      {children}
      <p className="my-[12px]">
        Run Roman&apos;s tools directly. These actions use this store and your
        current cart.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
        aria-busy={pending}
      >
        <label htmlFor={`${id}-tool`} className="block font-semibold">
          Tool
        </label>
        <select
          id={`${id}-tool`}
          value={name}
          disabled={pending}
          className="mt-[4px] w-full rounded-sm border border-solid border-[#E3E0D8] bg-transparent p-[8px] text-inherit"
          onChange={(event) => {
            const selected = toolDefinitions.find(
              (tool) => tool.name === event.target.value,
            )!;
            setName(selected.name);
            setInput(JSON.stringify(selected.example, null, 2));
            setResult(undefined);
            setError(undefined);
          }}
        >
          {toolDefinitions.map((tool) => (
            <option key={tool.name} value={tool.name}>
              {tool.name}
            </option>
          ))}
        </select>
        <p id={`${id}-description`} className="my-[12px]">
          {definition.description}
        </p>
        <label htmlFor={`${id}-input`} className="block font-semibold">
          Arguments (JSON)
        </label>
        <textarea
          id={`${id}-input`}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          aria-describedby={`${id}-description`}
          rows={5}
          spellCheck={false}
          disabled={pending}
          className="mt-[4px] block w-full resize-y rounded-sm border border-solid border-[#E3E0D8] bg-transparent p-[8px] font-mono text-[12px] text-inherit"
        />
        <button
          type="submit"
          disabled={pending}
          className="mt-[12px] min-h-[44px] cursor-pointer rounded-sm border border-solid border-[#4E0E0E] bg-[#4E0E0E] px-[16px] py-[8px] text-[#F7F5EF] disabled:cursor-wait disabled:opacity-50"
        >
          {pending
            ? "Running…"
            : "actionLabel" in definition
              ? definition.actionLabel
              : "Run tool"}
        </button>
      </form>
      <p role="status" className="my-[8px]">
        {pending
          ? "Waiting for tool result…"
          : result
            ? "Tool returned a result."
            : ""}
      </p>
      {error && (
        <p role="alert" className="my-[8px]">
          {error}
        </p>
      )}
      {result && (
        <textarea
          aria-label="Tool result"
          readOnly
          value={result}
          rows={12}
          spellCheck={false}
          className="m-0 block max-h-[320px] w-full resize-y overflow-auto rounded-sm border border-solid border-[#E3E0D8] bg-transparent p-[8px] font-mono text-[11px] text-inherit"
        />
      )}
    </details>
  );
}
