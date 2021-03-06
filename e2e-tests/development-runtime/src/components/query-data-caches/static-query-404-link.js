import { graphql, useStaticQuery } from "gatsby"

export function use404LinkStaticQuery() {
  return useStaticQuery(graphql`
    {
      queryDataCachesJson(
        selector: { eq: "static-query-404-to-B-to-404-link" }
      ) {
        ...QueryDataCachesFragmentInitialPage
      }
    }
  `)
}
