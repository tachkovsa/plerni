#define _GNU_SOURCE
/* undump — preload that clears dumpable after exec.
   execve of a same-uid binary resets PR_SET_DUMPABLE to the suid_dumpable
   default. The supervisor seals this object into a memfd and points
   LD_PRELOAD at that fd, so the constructor runs in the runtime before
   plugin code. The confinement filter allows only the zero value. */

#include <sys/prctl.h>

__attribute__((constructor)) static void plerni_clear_dumpable(void) {
  prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
}
