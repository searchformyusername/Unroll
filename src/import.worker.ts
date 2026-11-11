import { parse } from './parse';
self.onmessage = (event:MessageEvent<{text:string}>) => {try{self.postMessage({result:parse(event.data.text)});}catch(error){self.postMessage({error:error instanceof Error?error.message:'This trajectory could not be parsed.'});}};
