import { main } from './app';
import { toast } from './ui/dom';

main().catch((e) => {
  console.error(e);
  toast('启动失败：' + (e as Error).message, 5000);
});
