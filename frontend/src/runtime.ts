export type AssistantRuntime = {
  ready: Promise<void>;
  setOpen: (open: boolean) => void;
  focus: () => void;
  dispose: () => void;
};
