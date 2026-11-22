import os,re
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
MAGIC=b'SHINTOP-BACKUP-V1\x00'
def get_key(value):
 if not isinstance(value,str) or not re.fullmatch(r'[0-9a-fA-F]{64}',value):raise ValueError('BACKUP_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters')
 return bytes.fromhex(value)
def encrypt_backup(raw,key_hex):
 key=get_key(key_hex);nonce=os.urandom(12)
 return MAGIC+nonce+AESGCM(key).encrypt(nonce,raw,MAGIC)
def decrypt_backup(blob,key_hex):
 if not blob.startswith(MAGIC):raise ValueError('Unsupported backup format')
 nonce=blob[len(MAGIC):len(MAGIC)+12];ciphertext=blob[len(MAGIC)+12:]
 return AESGCM(get_key(key_hex)).decrypt(nonce,ciphertext,MAGIC)
