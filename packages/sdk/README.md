# @church/sdk

The typed client, built from `@church/contracts`. Web and mobile both consume it; neither
hand-writes a fetch call, so a contract change surfaces as a compile error instead of a
runtime surprise.

```ts
const client = createChurchClient({
  baseUrl: 'https://api.example.org/api/v1',
  getAccessToken: () => session.accessToken,
});

const result = await client.raw.GET('/churches/{churchId}', {
  params: { path: { churchId } },
});
const church = client.unwrap(result, `/churches/${churchId}`);
```

`getAccessToken` is a function, not a string: access tokens live 15 minutes, so a captured
one would start failing partway through a session.

`unwrap` throws rather than returning `{ data, error }`. The unhappy path here includes a
module being disabled, which the UI has to render deliberately — a shape that is easy to
ignore is the wrong shape for that.

- `ModuleNotEnabledError` — the route belongs to a module this church has not enabled.
  Render "this feature isn't enabled", not an error boundary.
- `ApiRequestError` — anything else, carrying `status`, `code`, and `requestId` for support.
