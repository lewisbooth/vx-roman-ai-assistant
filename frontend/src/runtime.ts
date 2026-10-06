export type AssistantRuntime = {
  ready: Promise<void>;
  setOpen: (open: boolean) => void;
  focus: () => void;
  visualizeProduct: (productPath: string) => void;
  dispose: () => void;
};
