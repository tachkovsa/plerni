#define _GNU_SOURCE
/* confine — exec wrapper for a plugin process (ADR-0006).
   Sets the process group, drops the ability to gain privileges, installs a
   seccomp filter, then execs the runtime. The filter rejects fork, vfork,
   and clone without CLONE_THREAD, rejects splice, vmsplice, tee, sendfile,
   and io_uring, rejects cross-process memory and fd calls, and makes clone3
   return ENOSYS so glibc falls back to clone. On x86_64 an nr with the x32
   bit set is rejected before any allow, so nr | __X32_SYSCALL_BIT cannot
   skip a deny. No shell. The supervisor publishes this binary beside the
   flow helper. */

#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__x86_64__)
#define CONFINED_ARCH AUDIT_ARCH_X86_64
#ifndef __X32_SYSCALL_BIT
#define __X32_SYSCALL_BIT 0x40000000
#endif
#elif defined(__aarch64__)
#define CONFINED_ARCH AUDIT_ARCH_AARCH64
#else
#error "confine: unsupported architecture"
#endif

#ifndef CLONE_THREAD
#define CLONE_THREAD 0x00010000
#endif

#define DENY_ERRNO(err) BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ((err) & SECCOMP_RET_DATA))
#define ALLOW BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)

/* True jumps to the errno return. False falls through to the next compare. */
#define DENY_NR(nr, err) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1), \
  DENY_ERRNO(err)

static int install_filter(void) {
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, CONFINED_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#ifdef __x86_64__
    /* The kernel's own miss for an x32 number is ENOSYS. EPERM is the
       filter, so a probe can tell the two apart when x32 is compiled out. */
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, __X32_SYSCALL_BIT, 0, 1),
    DENY_ERRNO(EPERM),
#endif
#ifdef __NR_fork
    DENY_NR(__NR_fork, EPERM),
#endif
#ifdef __NR_vfork
    DENY_NR(__NR_vfork, EPERM),
#endif
#ifdef __NR_clone3
    DENY_NR(__NR_clone3, ENOSYS),
#endif
#ifdef __NR_splice
    DENY_NR(__NR_splice, EPERM),
#endif
#ifdef __NR_vmsplice
    DENY_NR(__NR_vmsplice, EPERM),
#endif
#ifdef __NR_tee
    DENY_NR(__NR_tee, EPERM),
#endif
#ifdef __NR_sendfile
    DENY_NR(__NR_sendfile, EPERM),
#endif
#ifdef __NR_io_uring_setup
    DENY_NR(__NR_io_uring_setup, EPERM),
#endif
#ifdef __NR_io_uring_enter
    DENY_NR(__NR_io_uring_enter, EPERM),
#endif
#ifdef __NR_io_uring_register
    DENY_NR(__NR_io_uring_register, EPERM),
#endif
#ifdef __NR_pidfd_open
    DENY_NR(__NR_pidfd_open, EPERM),
#endif
#ifdef __NR_pidfd_getfd
    DENY_NR(__NR_pidfd_getfd, EPERM),
#endif
#ifdef __NR_ptrace
    DENY_NR(__NR_ptrace, EPERM),
#endif
#ifdef __NR_process_vm_readv
    DENY_NR(__NR_process_vm_readv, EPERM),
#endif
#ifdef __NR_process_vm_writev
    DENY_NR(__NR_process_vm_writev, EPERM),
#endif
#ifdef __NR_kcmp
    DENY_NR(__NR_kcmp, EPERM),
#endif
#ifdef __NR_prctl
    /* PR_SET_DUMPABLE(0) stays allowed so the preload can clear dumpable
       after exec. Any other value is EPERM. Other prctl operations pass. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_prctl, 0, 7),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, PR_SET_DUMPABLE, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, 1),
    ALLOW,
    DENY_ERRNO(EPERM),
    ALLOW,
#endif
#ifdef __NR_clone
    /* Allow only threads. A new process shares the stdio sockets. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, CLONE_THREAD),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, CLONE_THREAD, 0, 1),
    ALLOW,
    DENY_ERRNO(EPERM),
#endif
    ALLOW,
  };
  struct sock_fprog prog = {
    .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
    .filter = filter,
  };
  if (syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog) != 0) return -1;
  return 0;
}

/* Loader variables in the initial environment run before main. The supervisor
   allowlists that environment. Plugin variables arrive on fd 5 and are applied
   only after the filter. LD_PRELOAD is then forced to the sealed preload. */
static int tainted_loader_env(void) {
  static const char *keys[] = {
    "LD_AUDIT",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "LD_PROFILE",
    "LD_ORIGIN_PATH",
    "LD_DEBUG",
    "LD_DEBUG_OUTPUT",
    "LD_SHOW_AUXV",
    "LD_TRACE_LOADED_OBJECTS",
    "LD_DYNAMIC_WEAK",
    "LD_BIND_NOW",
    "LD_BIND_NOT",
    "LD_ASSUME_KERNEL",
    NULL,
  };
  for (int i = 0; keys[i] != NULL; i++) {
    const char *value = getenv(keys[i]);
    if (value != NULL && value[0] != '\0') return 1;
  }
  return 0;
}

static int apply_fd_env(int fd) {
  size_t cap = 4096;
  size_t len = 0;
  char *buf = malloc(cap);
  if (buf == NULL) return -1;
  for (;;) {
    if (len == cap) {
      if (cap >= 256 * 1024) {
        free(buf);
        return -1;
      }
      size_t next = cap * 2;
      if (next > 256 * 1024) next = 256 * 1024;
      char *grown = realloc(buf, next);
      if (grown == NULL) {
        free(buf);
        return -1;
      }
      buf = grown;
      cap = next;
    }
    ssize_t n = read(fd, buf + len, cap - len);
    if (n < 0) {
      if (errno == EINTR) continue;
      free(buf);
      return -1;
    }
    if (n == 0) break;
    len += (size_t)n;
  }
  close(fd);
  if (clearenv() != 0) {
    free(buf);
    return -1;
  }
  size_t i = 0;
  while (i < len) {
    size_t start = i;
    while (i < len && buf[i] != '\0') i++;
    if (i >= len) {
      free(buf);
      return -1;
    }
    buf[i] = '\0';
    char *eq = strchr(buf + start, '=');
    if (eq == NULL || eq == buf + start) {
      free(buf);
      return -1;
    }
    *eq = '\0';
    if (strncmp(buf + start, "LD_", 3) != 0) {
      if (setenv(buf + start, eq + 1, 1) != 0) {
        free(buf);
        return -1;
      }
    }
    i++;
  }
  free(buf);
  if (setenv("LD_PRELOAD", "/proc/self/fd/4", 1) != 0) return -1;
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 3 || argv[1] == NULL) return 127;
  if (tainted_loader_env()) return 127;
  /* Own process group before the filter, so the supervisor can kill it. */
  if (setpgid(0, 0) != 0) return 127;
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return 127;
  if (install_filter() != 0) return 127;
  if (apply_fd_env(5) != 0) return 127;
  execv(argv[1], argv + 1);
  return 127;
}
