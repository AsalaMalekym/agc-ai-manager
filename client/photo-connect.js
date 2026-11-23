// No token leaves this page except to VK Bridge and the user's clipboard.
export function startPhotoConnect(bridge, document, window) {
  const $=id=>document.getElementById(id),appId=54914147,groupId=243571492;
  let serial=0;
  const setStatus=text=>{$('status').textContent=text;};
  const clear=()=>{serial++;$('token').value='';$('result').hidden=true;$('token').type='password';};
  const timed=(promise,ms)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject({timeout:true}),ms);})]).finally(()=>clearTimeout(timer));};
  const errorCode=e=>{const code=e?.error_data?.error_code??e?.error?.error_code??e?.error_code;return Number.isInteger(Number(code))&&code!==undefined?String(Number(code)):'не указан';};
  clear();window.addEventListener('pagehide',clear);
  // VK must receive Init at startup to dismiss its loading overlay.
  let initPromise;
  const initialize=()=>{
    if(!initPromise)initPromise=timed(Promise.resolve().then(()=>bridge.send('VKWebAppInit')),10000)
      .then(()=>({ok:true}),error=>{initPromise=undefined;return {ok:false,error};});
    return initPromise;
  };
  if(bridge.isEmbedded())void initialize();
  $('copy').onclick=async()=>{
    if(!$('token').value)return;
    try{await window.navigator.clipboard.writeText($('token').value);setStatus('Ключ скопирован. Вставьте его в Secret VK_PHOTO_TOKEN в Cloudflare. Не отправляйте ключ в чат.');}
    catch{$('token').type='text';$('token').focus();$('token').select();setStatus('Выделите и скопируйте ключ вручную. Не делайте скриншот открытого ключа.');}
  };
  $('hide').onclick=()=>{clear();setStatus('Ключ убран со страницы. Это не отзывает его в ВК.');};
  $('connect').onclick=async()=>{
    clear();const request=serial;$('connect').disabled=true;let token='';
    try{
      const params=new URLSearchParams(window.location.search);
      if(params.get('vk_app_id')!==String(appId)||!bridge.isEmbedded()){
        setStatus('Откройте эту страницу внутри приложения AGai через ВК. Прямая ссылка в браузере не выдаёт пользовательский ключ.');return;
      }
      setStatus('Соединяемся с ВК…');const init=await initialize();if(request!==serial)return;if(!init.ok)throw init.error;
      setStatus('Подтвердите доступ к фотографиям в окне ВК.');
      const auth=await timed(bridge.send('VKWebAppGetAuthToken',{app_id:appId,scope:'photos'}),90000);if(request!==serial)return;
      if(typeof auth?.access_token!=='string'||auth.access_token.length<20||!String(auth.scope||'').split(',').map(s=>s.trim()).includes('photos')){
        setStatus('ВК не выдал пользовательский ключ с правом photos. Сервисный или защищённый ключ приложения его не заменяет.');return;
      }
      token=auth.access_token;setStatus('Проверяем разрешение на загрузку фото для группы. Публикации не создаются.');
      const result=await timed(bridge.send('VKWebAppCallAPIMethod',{method:'photos.getWallUploadServer',params:{group_id:groupId,v:'5.199',access_token:token}}),20000);if(request!==serial)return;
      if(result?.error)throw result;
      const response=result?.response??result;
      if(typeof response?.upload_url!=='string'||!response.upload_url.startsWith('https://')){
        setStatus('ВК не подтвердил доступ к серверу загрузки фото. Ключ пока не подключаем.');return;
      }
      $('token').value=token;$('result').hidden=false;
      setStatus('ВК разрешил получение адреса загрузки через приложение. Скопируйте ключ в VK_PHOTO_TOKEN. Затем Worker отдельно проверит серверный доступ; ключ может оказаться временным.');
    }catch(error){
      clear();setStatus(error?.timeout?'ВК не ответил вовремя. Закройте окно запроса и попробуйте снова.':'ВК отклонил запрос. Код: '+errorCode(error)+'. Можно прислать этот код, но не ключ. Доступ к photos не гарантирует доступ ко всем методам.');
    }finally{token='';$('connect').disabled=false;}
  };
}
