export function publicCallbackUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Callback endpoint validation failed.');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const localSuffixes = ['.localhost', '.local', '.internal', '.home.arpa', '.test', '.example', '.invalid'];
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
  const isIpv6 = hostname.includes(':');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      (url.port && url.port !== '443') || !hostname.includes('.') || isIpv4 || isIpv6 ||
      hostname === 'localhost' || localSuffixes.some((suffix) => hostname.endsWith(suffix))) {
    throw new TypeError('Callback endpoint validation failed.');
  }
  return url.toString();
}
