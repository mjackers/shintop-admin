"""Probe conditional-write behavior only on a fresh disposable object."""
import hashlib,secrets
from botocore.exceptions import ClientError

def condition(etag,mode):
 value=str(etag).strip()
 if mode=='bare':return value.strip('"')
 return '"'+value.strip('"')+'"'

def choose_mode(client,bucket,prefix):
 # Public bucket: test bytes are random only, never catalog contents.
 for mode in ('quoted','bare'):
  name=prefix.rstrip('/')+'/compat-'+secrets.token_hex(16)+'.bin'
  first=secrets.token_bytes(48);second=secrets.token_bytes(48)
  def read():
   obj=client.get_object(Bucket=bucket,Key=name)
   return obj['Body'].read(),obj['ETag']
  def put(data,match=None):
   args=dict(Bucket=bucket,Key=name,Body=data,ContentType='application/octet-stream',CacheControl='no-store')
   if match is not None:args['IfMatch']=match
   return client.put_object(**args)
  try:
   put(first);actual,tag=read()
   if actual!=first:continue
   # Wrong precondition MUST be rejected and leave data intact.
   try:put(second,condition('invalid-'+secrets.token_hex(16),mode))
   except ClientError as e:
    if str(e.response.get('Error',{}).get('Code')) not in ('PreconditionFailed','412'):continue
   else:continue
   if read()[0]!=first:continue
   try:put(second,condition(tag,mode))
   except ClientError:continue
   actual,newtag=read()
   if actual!=second:continue
   # A stale version MUST also be rejected, not merely arbitrary strings.
   try:put(first,condition(tag,mode))
   except ClientError as e:
    if str(e.response.get('Error',{}).get('Code')) not in ('PreconditionFailed','412'):continue
   else:continue
   if read()[0]!=second:continue
   return mode
  finally:
   try:client.delete_object(Bucket=bucket,Key=name)
   except Exception:pass
 raise RuntimeError('S3_SAFE_CONDITIONAL_WRITE_UNAVAILABLE')
