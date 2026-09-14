import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { APP_NAME } from "../../shared/brand";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const themeEditorUrl = new URL(
    `https://${session.shop}/admin/themes/current/editor`,
  );
  themeEditorUrl.searchParams.set("context", "apps");
  themeEditorUrl.searchParams.set(
    "activateAppId",
    `${process.env.SHOPIFY_API_KEY}/roman-assistant`,
  );

  return { themeEditorUrl: themeEditorUrl.toString() };
};

export default function Home() {
  const { themeEditorUrl } = useLoaderData<typeof loader>();

  return (
    <s-page heading={APP_NAME}>
      <s-section heading="Storefront assistant">
        <s-paragraph>
          Enable the Assistant icon app embed in your theme and save your
          changes to show the R icon in the bottom-left corner of your
          storefront.
        </s-paragraph>
        <s-button href={themeEditorUrl} target="_blank" variant="primary">
          Open theme editor
        </s-button>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
