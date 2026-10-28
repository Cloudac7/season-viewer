/** Keep transport status and retry guidance available to scheduled updaters. */
export class OpenMeteoHttpError extends Error {
  readonly status:number;
  readonly retryAfter:string|null;

  constructor(response:Response, context=''){
    super(`Open-Meteo ${context}HTTP ${response.status}`);
    this.name='OpenMeteoHttpError';
    this.status=response.status;
    this.retryAfter=response.headers.get('retry-after');
  }
}

/** Transport failures can be retried without treating invalid data as transient. */
export class OpenMeteoNetworkError extends Error {
  constructor(cause:unknown){
    super('Open-Meteo network request failed',{cause});
    this.name='OpenMeteoNetworkError';
  }
}

/** The API accepts form POST for multiple coordinates, avoiding long URLs. */
export async function fetchOpenMeteo(params:URLSearchParams,signal:AbortSignal,context=''):Promise<Response>{
  let response:Response;
  try{
    response=await fetch('https://api.open-meteo.com/v1/forecast',{
      method:'POST',
      headers:{'content-type':'application/x-www-form-urlencoded'},
      body:params,
      signal,
    });
  }catch(error){throw new OpenMeteoNetworkError(error);}
  if(!response.ok)throw new OpenMeteoHttpError(response,context);
  return response;
}
