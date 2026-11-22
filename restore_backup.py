from pathlib import Path
from getpass import getpass
import argparse,json
from backup_crypto import decrypt_backup
p=argparse.ArgumentParser(description='Decrypt downloaded SHINTOP backup locally. Does not publish.');p.add_argument('input');p.add_argument('output');a=p.parse_args()
raw=decrypt_backup(Path(a.input).read_bytes(),getpass('BACKUP_ENCRYPTION_KEY: ').strip());json.loads(raw)
with open(a.output,'xb') as f:f.write(raw)
print('Decrypted locally. Review before manually restoring.')
