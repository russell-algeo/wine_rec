/** Strip hosted font requests before the browser parses the isolated page. */
export function isolatedHtml(html: string, isolated: boolean): string {
  return isolated ? html.replace(/<!-- hosted-fonts:start -->[\s\S]*?<!-- hosted-fonts:end -->/, "") : html;
}
