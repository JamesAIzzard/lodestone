declare module 'libmime' {
  interface DecodedHeaders {
    [name: string]: string[] | undefined;
  }

  interface Libmime {
    decodeHeaders(headers: string): DecodedHeaders;
    decodeWords(value: string): string;
  }

  const libmime: Libmime;
  export default libmime;
}
