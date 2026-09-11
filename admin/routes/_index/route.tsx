import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";
import { APP_NAME, ASSISTANT_INITIAL } from "../../../shared/brand";
import { login } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return { showForm: Boolean(login) };
};

export default function Index() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <main className="grid min-h-dvh place-items-center bg-stone-50 px-6 py-12 text-zinc-900">
      <div className="w-full max-w-sm">
        <div
          aria-hidden="true"
          className="mb-6 grid size-12 place-items-center rounded-full bg-zinc-900 font-serif text-2xl font-semibold text-white"
        >
          {ASSISTANT_INITIAL}
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">{APP_NAME}</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          Sign in to manage your storefront assistant.
        </p>
        {showForm && (
          <Form className="mt-8 space-y-4" method="post" action="/auth/login">
            <label className="block text-sm font-medium" htmlFor="shop">
              Shop domain
            </label>
            <input
              id="shop"
              name="shop"
              type="text"
              required
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="your-store.myshopify.com"
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-base outline-offset-2 focus-visible:outline-2 focus-visible:outline-zinc-900"
            />
            <button
              type="submit"
              className="w-full cursor-pointer rounded-lg bg-zinc-900 px-4 py-3 text-sm font-medium text-white hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
            >
              Sign in
            </button>
          </Form>
        )}
      </div>
    </main>
  );
}
