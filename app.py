import os,json,secrets,time,hashlib,math,threading
from pathlib import Path
from datetime import timedelta,datetime,timezone
from functools import wraps
from urllib.parse import urlparse
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from flask import Flask,request,session,jsonify,redirect,send_from_directory,render_template_string
from werkzeug.security import check_password_hash
from backup_crypto import encrypt_backup
ROOT=Path(__file__).resolve().parent
app=Flask(__name__,static_folder=str(ROOT/"static"))
app.secret_key=os.environ['SESSION_SECRET']
if len(app.secret_key)<40:raise RuntimeError('SESSION_SECRET must have at least 40 characters')
password_hash=os.environ['ADMIN_PASSWORD_HASH']
origin=os.environ['ADMIN_ORIGIN'].rstrip('/')
if not origin.startswith('https://'):raise RuntimeError('ADMIN_ORIGIN must use HTTPS')
app.config.update(MAX_CONTENT_LENGTH=8*1024*1024,SESSION_COOKIE_SECURE=True,SESSION_COOKIE_HTTPONLY=True,SESSION_COOKIE_SAMESITE='Strict',PERMANENT_SESSION_LIFETIME=timedelta(minutes=30))
s3=boto3.client('s3',endpoint_url=os.environ['S3_ENDPOINT'],region_name=os.getenv('S3_REGION','ru-1'),aws_access_key_id=os.environ['S3_ACCESS_KEY'],aws_secret_access_key=os.environ['S3_SECRET_KEY'],config=Config(signature_version='s3v4',connect_timeout=10,read_timeout=45,retries={'max_attempts':2},s3={'addressing_style':'path'}))
bucket=os.environ['S3_BUCKET'];key=os.getenv('CATALOG_KEY','products.json')
backup_prefix=os.getenv('BACKUP_PREFIX','encrypted-catalog-backups').strip('/')+'/'
backup_key=os.environ['BACKUP_ENCRYPTION_KEY']
# Validate encryption configuration before serving any requests.
encrypt_backup(b'configuration-check',backup_key)
if backup_prefix==key or key.startswith(backup_prefix):raise RuntimeError('Backup prefix overlaps catalog')
# A single worker is required for process-local rate limits and publish lock.
failures=[];publish_lock=threading.Lock()
def token():
 if 'csrf' not in session:session['csrf']=secrets.token_urlsafe(32)
 return session['csrf']
def require_auth(fn):
 @wraps(fn)
 def wrapped(*a,**k):
  if not session.get('authenticated'):return jsonify(error='Войдите в панель'),401
  return fn(*a,**k)
 return wrapped
def check_csrf():
 return request.headers.get('Origin')==origin and secrets.compare_digest(request.headers.get('X-CSRF-Token',''),session.get('csrf','!'))
def read_catalog():
 obj=s3.get_object(Bucket=bucket,Key=key)
 raw=obj['Body'].read(8*1024*1024+1)
 if len(raw)>8*1024*1024:raise ValueError('Каталог слишком большой')
 data=json.loads(raw);validate(data)
 return raw,data,obj['ETag']
def validate(data):
 if not isinstance(data,list) or not data or len(data)>20000:raise ValueError('Некорректный каталог')
 ids=set()
 for p in data:
  if not isinstance(p,dict) or type(p.get('id')) is not int or p['id'] in ids:raise ValueError('Некорректный или повторный ID')
  ids.add(p['id'])
  if type(p.get('qty')) is not int or not 0<=p['qty']<=100000:raise ValueError('Некорректный остаток')
  if 'price' in p and (type(p['price']) not in (int,float) or not math.isfinite(p['price']) or not 0<p['price']<=10000000):raise ValueError('Некорректная цена')
  for field in ['brand','model','size']:
   if not isinstance(p.get(field),str) or len(p[field])>400:raise ValueError('Некорректные характеристики')
  # Never let imported data carry active URLs or markup in image/link properties.
  for field in ['image','url']:
   if field in p:
    value=p[field]
    if not isinstance(value,str) or len(value)>3000 or urlparse(value).scheme not in ('https','http'):raise ValueError('Некорректный адрес изображения/товара')
@app.after_request
def secure(response):
 response.headers['Cache-Control']='no-store'
 response.headers['X-Content-Type-Options']='nosniff'
 response.headers['Referrer-Policy']='no-referrer'
 response.headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
 return response
@app.errorhandler(413)
def too_big(e):return jsonify(error='Слишком большой файл'),413
@app.get('/health')
def health():return {'ok':True}
@app.route('/login',methods=['GET','POST'])
def login():
 global failures
 if request.method=='POST':
  now=time.time();failures=[t for t in failures if now-t<900]
  if len(failures)>=10:return 'Слишком много попыток. Повторите через 15 минут.',429
  if request.headers.get('Origin')!=origin or not secrets.compare_digest(request.form.get('csrf',''),session.get('csrf','!')):return 'CSRF',403
  if check_password_hash(password_hash,request.form.get('password','')):
   session.clear();session['authenticated']=True;session.permanent=True;token();return redirect('/')
  failures.append(now)
 return render_template_string('<meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ШИНТОП — вход</title><body style="background:#14161b;color:white;font:18px Arial;padding:40px"><h1>Управление каталогом</h1><form method="post"><input type="hidden" name="csrf" value="{{csrf}}"><input type="password" name="password" autocomplete="current-password" required placeholder="Пароль"><button>Войти</button></form></body>',csrf=token())
@app.get('/')
def index():
 if not session.get('authenticated'):return redirect('/login')
 return send_from_directory(str(ROOT/'static'),'admin.html')
@app.get('/api/map')
@require_auth
def mapping():return send_from_directory(str(ROOT), 'import-map.json')
@app.get('/api/catalog')
@require_auth
def catalog():
 try:raw,data,etag=read_catalog();return jsonify(products=data,version=etag,csrf=token())
 except Exception:app.logger.exception('Catalog read failed');return jsonify(error='Не удалось прочитать каталог S3. Проверьте настройки сервера.'),503
@app.post('/api/publish')
@require_auth
def publish():
 if not check_csrf():return jsonify(error='Проверка безопасности не пройдена. Обновите страницу.'),403
 body=request.get_json(silent=True) or {};data=body.get('products');version=body.get('version')
 try:validate(data)
 except ValueError as e:return jsonify(error=str(e)),400
 if not publish_lock.acquire(blocking=False):return jsonify(error='Другая публикация выполняется'),409
 try:
  raw,old,etag=read_catalog()
  if version!=etag:return jsonify(error='Каталог уже изменился. Перезагрузите страницу и повторите импорт.'),409
  oldids={p['id'] for p in old}
  if not oldids.issubset({p['id'] for p in data}):return jsonify(error='Удаление существующих ID запрещено: задайте остаток 0.'),400
  # Publication changes only price/inventory fields for existing IDs.
  allowed={'price','pricePack','qty','importName','importSku','inventorySource','availability'}
  oldby={p['id']:p for p in old}
  for p in data:
   if p['id'] in oldby and {k:v for k,v in p.items() if k not in allowed}!={k:v for k,v in oldby[p['id']].items() if k not in allowed}:return jsonify(error='Изменены характеристики существующего товара. Повторите импорт.'),400
  backup=backup_prefix+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')+'-'+secrets.token_hex(6)+'.json.enc'
  # Encrypt locally BEFORE storage. Public bucket policy may expose ciphertext, never raw catalog.
  encrypted=encrypt_backup(raw,backup_key)
  s3.put_object(Bucket=bucket,Key=backup,Body=encrypted,ContentType='application/octet-stream',CacheControl='no-store')
  encoded=json.dumps(data,ensure_ascii=False,allow_nan=False).encode()
  # Conditional write prevents overwriting concurrent updates; provider must support IfMatch.
  result=s3.put_object(Bucket=bucket,Key=key,Body=encoded,ContentType='application/json; charset=utf-8',CacheControl='no-cache,max-age=0,must-revalidate',IfMatch=etag)
  return jsonify(products=data,version=result['ETag'],backup=backup)
 except ClientError as e:
  code=e.response.get('Error',{}).get('Code','')
  app.logger.exception('S3 publication failed')
  return jsonify(error='Конфликт версии. Обновите каталог.' if code in ('PreconditionFailed','412') else 'S3 отклонил запись. Проверьте права, приватность резервных копий и поддержку условной записи. Публикация не подтверждена.'),409 if code in ('PreconditionFailed','412') else 503
 except Exception:app.logger.exception('Publication failed');return jsonify(error='Публикация не подтверждена. Проверьте каталог перед повторной попыткой.'),503
 finally:publish_lock.release()
@app.post('/logout')
@require_auth
def logout():
 if not check_csrf():return '',403
 session.clear();return '',204
