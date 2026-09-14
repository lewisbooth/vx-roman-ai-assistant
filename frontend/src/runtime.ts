export type AssistantRuntime = {
  ready: Promise<void>;
  setOpen: (open: boolean) => void;
  dispose: () => void;
};
