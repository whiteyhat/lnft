import wretch from "wretch";
export const api = wretch().url("/api");
export const electrs = wretch().url("/api/el");
export const hasura = wretch().url("/api/v1/graphql");
