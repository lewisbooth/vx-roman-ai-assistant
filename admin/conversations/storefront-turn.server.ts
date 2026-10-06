import { parseCheckoutCall, parseCheckoutResult } from "../../shared/checkout";
import { parseViewCall, parseViewResult } from "../../shared/assistant-view";
import { parseStoreSupportCall } from "../../shared/store-support";
import { parseNavigationCall, parseNavigationResult } from "../../shared/navigation-tool";
import {
  isCartMutation,
  isCartTool,
  parseCartCall,
  parseCartResult,
} from "../../shared/cart-tools";
import {
  isProductConfigurationTool,
  parseProductConfigurationCall,
  parseProductConfigurationResult,
  type ProductConfiguration,
} from "../../shared/product-configuration";
import { parseMeasurementCall } from "../../shared/measurements";
import { parseCatalogCall } from "../../shared/catalog-tools";
import type { BrowserToolOutcome } from "./browser-tools.server";
import type { MeasurementToolResult } from "../../shared/measurements";

/** Domain parsing stays beside its execution preconditions, outside the model loop. */
export function parseStorefrontCall(name: string, input: unknown) {
  switch (name) {
    case "open_checkout":
      return { name, arguments: parseCheckoutCall(input) };
    case "show_view":
      return { name, arguments: parseViewCall(input) };
    case "get_store_support":
      return { name, arguments: parseStoreSupportCall(input) };
    case "navigate":
      return { name, arguments: parseNavigationCall(input) };
    case "apply_measurements":
      return {
        name,
        arguments: parseMeasurementCall("get_measurements", input).arguments,
      };
    case "get_measurements":
    case "set_measurements":
      return parseMeasurementCall(name, input);
    default:
      if (isCartTool(name)) return parseCartCall(name, input);
      if (isProductConfigurationTool(name))
        return parseProductConfigurationCall(name, input);
      return parseCatalogCall(name, input);
  }
}

export function isConfigurationStep(name: string) {
  return (
    isProductConfigurationTool(name) ||
    name === "set_measurements" ||
    name === "get_measurements" ||
    name === "apply_measurements"
  );
}

/** One turn's mutation permission; a model's tool choice is never authorization. */
export class StorefrontTurn {
  private cartAttempted = false;
  private readonly samplePaths = new Set<string>();
  private sampleConfirmed = false;
  private formProductPath?: string;
  private formBlocked = false;
  private configurationAttempts = 0;
  private measurementAttempted = false;
  private currentConfiguration?: ProductConfiguration;
  configurationMode = false;
  checkoutAttempted = false;
  checkoutHandoff = false;

  get sampleAttempted() {
    return this.samplePaths.size > 0;
  }

  /** A confirmed first sample may finish one other requested product sample. */
  isSampleContinuation(name: string): boolean {
    return (
      this.sampleConfirmed &&
      this.samplePaths.size < 2 &&
      !this.checkoutHandoff &&
      !this.formBlocked &&
      !this.formProductPath &&
      ["get_product", "lookup_catalog", "navigate", "add_sample_to_cart"].includes(name)
    );
  }

  /** Only a newly validated browser read can establish a mutable capability. */
  observeConfiguration(configuration: ProductConfiguration) {
    this.currentConfiguration = undefined;
    if (configuration.status === "available") {
      this.currentConfiguration = configuration;
      this.configurationMode = true;
    }
  }

  /** Complete the same product after verified form work; native validation still owns submission. */
  isConfigurationCompletion(name: string): boolean {
    const configuration = this.currentConfiguration;
    const measurements = configuration?.measurements;
    return (
      name === "add_to_cart" &&
      !this.checkoutHandoff &&
      !this.cartAttempted &&
      !this.formBlocked &&
      !!this.formProductPath &&
      configuration?.productPath === this.formProductPath &&
      !!configuration.configuredPrice &&
      !!measurements?.unit &&
      measurements.availableUnits.includes(measurements.unit) &&
      measurements.width !== null &&
      measurements.width > 0 &&
      measurements.height !== null &&
      measurements.height > 0
    );
  }

  allows(name: string): boolean {
    if (
      this.checkoutHandoff ||
      (name === "open_checkout" && this.checkoutAttempted)
    )
      return false;
    if (name === "add_sample_to_cart")
      return (
        !this.formBlocked &&
        !this.formProductPath &&
        (!this.cartAttempted || this.isSampleContinuation(name))
      );
    if (isCartMutation(name))
      return (
        !this.cartAttempted &&
        !this.formBlocked &&
        (!this.formProductPath || this.isConfigurationCompletion(name))
      );
    if (name === "configure_product")
      return (
        !this.cartAttempted &&
        !this.formBlocked &&
        this.configurationAttempts < 3 &&
        !!this.currentConfiguration
      );
    if (name === "apply_measurements")
      return (
        !this.cartAttempted &&
        !this.formBlocked &&
        !this.measurementAttempted &&
        (this.configurationAttempts === 0 || !!this.currentConfiguration)
      );
    return true;
  }

  before(call: ReturnType<typeof parseStorefrontCall>) {
    if (!this.allows(call.name))
      throw new Error("This storefront change is not available in this reply.");
    if (
      call.name === "add_to_cart" &&
      this.formProductPath &&
      (!("productPath" in call.arguments) ||
        call.arguments.productPath !== this.formProductPath)
    )
      throw new Error("The configured addition must stay on the same product.");
    if (call.name === "navigate") {
      this.currentConfiguration = undefined;
      if (this.formProductPath) this.formBlocked = true;
    }
    if (call.name === "open_checkout") this.checkoutAttempted = true;
    if (call.name === "add_sample_to_cart") {
      const path = call.arguments.productPath as string;
      if (this.samplePaths.has(path))
        throw new Error("This product's sample has already been attempted in this reply.");
      // Reserve before dispatch. Until confirmed, no other sample may run.
      this.samplePaths.add(path);
      this.sampleConfirmed = false;
    }
    if (isCartMutation(call.name)) this.cartAttempted = true;
    if (
      call.name === "configure_product" ||
      call.name === "apply_measurements"
    ) {
      const args = call.arguments as {
        productPath: string;
        configurationId?: string;
        controlId?: string;
        optionId?: string;
      };
      if (this.formProductPath && this.formProductPath !== args.productPath)
        throw new Error("Configuration changes must stay on the same product.");
      if (call.name === "configure_product") {
        const snapshot = this.currentConfiguration;
        this.currentConfiguration = undefined;
        const option = snapshot?.controls
          .find(({ id }) => id === args.controlId)
          ?.options.find(({ id }) => id === args.optionId);
        if (
          snapshot?.productPath !== args.productPath ||
          snapshot?.configurationId !== args.configurationId ||
          !option?.available
        )
          throw new Error(
            "Read the available product choices before each change.",
          );
        this.configurationAttempts++;
      } else {
        if (
          this.configurationAttempts &&
          this.currentConfiguration?.productPath !== args.productPath
        )
          throw new Error(
            "Read the changed product before applying measurements.",
          );
        this.measurementAttempted = true;
        this.currentConfiguration = undefined;
      }
      this.formProductPath = args.productPath;
      this.formBlocked = true;
    }
    if (call.name === "get_product_configuration")
      this.currentConfiguration = undefined;
  }

  after(
    call: ReturnType<typeof parseStorefrontCall>,
    outcome: BrowserToolOutcome | MeasurementToolResult,
  ) {
    if (this.isSampleContinuation(call.name)) {
      if ("error" in outcome ||
          ((call.name === "get_product" || call.name === "lookup_catalog") &&
            (!("products" in outcome) || outcome.products.length === 0)))
        this.sampleConfirmed = false;
      else if (call.name === "navigate" &&
          parseNavigationResult(outcome).path !== parseNavigationCall(call.arguments).path)
        throw new Error("Sample preparation returned a different product page.");
    }
    if (call.name === "add_sample_to_cart") {
      const result = parseCartResult(call.name, outcome);
      if ("status" in result && result.status === "added" &&
          result.addedSample?.productPath !== call.arguments.productPath)
        throw new Error("The added sample returned a different product.");
      this.sampleConfirmed =
        "status" in result &&
        (result.status === "already_in_cart" ||
          (result.status === "added" &&
            result.addedSample?.productPath === call.arguments.productPath));
    }
    if (call.name === "get_product_configuration") {
      const configuration = parseProductConfigurationResult(call.name, outcome);
      if (
        !("productPath" in call.arguments) ||
        configuration.productPath !== call.arguments.productPath
      )
        throw new Error("Configuration returned a different product.");
      this.observeConfiguration(configuration);
    }
    if (call.name === "configure_product" || call.name === "apply_measurements") {
      this.formBlocked = !(
        "status" in outcome &&
        outcome.status === "applied" &&
        "productPath" in outcome &&
        outcome.productPath === this.formProductPath
      );
      if (!this.formBlocked && "configuration" in outcome && outcome.configuration) {
        const configuration = parseProductConfigurationResult("get_product_configuration", outcome.configuration);
        if (configuration.productPath !== this.formProductPath)
          throw new Error("Configuration returned a different applied product.");
        this.observeConfiguration(configuration);
      }
    }
    if (call.name === "open_checkout" && !("error" in outcome)) {
      parseCheckoutResult(outcome);
      this.checkoutHandoff = true;
    }
    if (
      call.name === "show_view" &&
      !("error" in outcome) &&
      parseViewResult(outcome).view !== parseViewCall(call.arguments).view
    )
      throw new Error("The browser showed a different Roman view.");
  }

  failed(name: string) {
    if (name === "add_sample_to_cart" || this.isSampleContinuation(name))
      this.sampleConfirmed = false;
    if (name === "configure_product" || name === "apply_measurements") {
      this.formBlocked = true;
      this.currentConfiguration = undefined;
    }
  }
}
