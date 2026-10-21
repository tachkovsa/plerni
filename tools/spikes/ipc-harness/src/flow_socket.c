#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <linux/seccomp.h>
#include <linux/sockios.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <node_api.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef __X32_SYSCALL_BIT
#define __X32_SYSCALL_BIT 0x40000000
#endif

#ifndef F_ADD_SEALS
#define F_ADD_SEALS 1033
#endif
#ifndef F_GET_SEALS
#define F_GET_SEALS 1034
#endif
#ifndef F_SEAL_SEAL
#define F_SEAL_SEAL 0x0001
#endif
#ifndef F_SEAL_SHRINK
#define F_SEAL_SHRINK 0x0002
#endif
#ifndef F_SEAL_GROW
#define F_SEAL_GROW 0x0004
#endif
#ifndef F_SEAL_WRITE
#define F_SEAL_WRITE 0x0008
#endif

/* Child stdio ends for the flow-control reservation.
   socketpair, SO_SNDBUF on each writer, a dup of the stdin read end for
   FIONREAD, and shutdown of the unused direction. SIOCOUTQ is not read:
   on AF_UNIX it counts skb truesize, not payload bytes. */

static void close_quiet(int fd) {
  if (fd >= 0) close(fd);
}

static void close_all(int in0, int in1, int out0, int out1, int probe, int writer) {
  close_quiet(in0);
  close_quiet(in1);
  close_quiet(out0);
  close_quiet(out1);
  close_quiet(probe);
  close_quiet(writer);
}

static int read_sockopt(int fd, int opt, int *got) {
  int value = 0;
  socklen_t len = sizeof(value);
  if (getsockopt(fd, SOL_SOCKET, opt, &value, &len) != 0 || value <= 0) return -1;
  *got = value;
  return 0;
}

static int set_sockopt(int fd, int opt, int request, int *got) {
  if (setsockopt(fd, SOL_SOCKET, opt, &request, sizeof(request)) != 0) return -1;
  return read_sockopt(fd, opt, got);
}

static int read_sndbuf(int fd, int *got) {
  return read_sockopt(fd, SO_SNDBUF, got);
}

static int set_sndbuf(int fd, int request, int *got) {
  return set_sockopt(fd, SO_SNDBUF, request, got);
}

static napi_value int_prop(napi_env env, napi_value obj, const char *name, int value) {
  napi_value out;
  if (napi_create_int32(env, value, &out) != napi_ok) return NULL;
  if (napi_set_named_property(env, obj, name, out) != napi_ok) return NULL;
  return obj;
}

static napi_value Create(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t request = 0;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &request) != napi_ok || request <= 0) {
    napi_throw_type_error(env, NULL, "sndbuf");
    return NULL;
  }
  int in[2] = {-1, -1};
  int out[2] = {-1, -1};
  int probe = -1;
  int writer = -1;
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, in) != 0) {
    napi_throw_error(env, NULL, "socketpair");
    return NULL;
  }
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, out) != 0) {
    close_all(in[0], in[1], -1, -1, -1, -1);
    napi_throw_error(env, NULL, "socketpair");
    return NULL;
  }
  /* in[0] is the parent's stdin writer. out[0] is the child's stdout writer. */
  int sndbuf_out = 0;
  int sndbuf_in = 0;
  if (set_sndbuf(in[0], request, &sndbuf_out) != 0 || set_sndbuf(out[0], request, &sndbuf_in) != 0) {
    close_all(in[0], in[1], out[0], out[1], -1, -1);
    napi_throw_error(env, NULL, "sndbuf");
    return NULL;
  }
  probe = dup(in[1]);
  writer = dup(out[0]);
  if (probe < 0 || writer < 0
      || fcntl(probe, F_SETFD, FD_CLOEXEC) != 0
      || fcntl(writer, F_SETFD, FD_CLOEXEC) != 0) {
    close_all(in[0], in[1], out[0], out[1], probe, writer);
    napi_throw_error(env, NULL, "dup");
    return NULL;
  }
  /* The child inherits in[1] as fd 0 and out[0] as fd 1. Shut the directions
     it must not use. shutdown is not reversible. The writer dup shares that
     socket, so a later SO_SNDBUF on the child's fd is visible here. */
  if (shutdown(in[1], SHUT_WR) != 0 || shutdown(out[0], SHUT_RD) != 0) {
    close_all(in[0], in[1], out[0], out[1], probe, writer);
    napi_throw_error(env, NULL, "shutdown");
    return NULL;
  }
  napi_value obj;
  if (napi_create_object(env, &obj) != napi_ok) {
    close_all(in[0], in[1], out[0], out[1], probe, writer);
    napi_throw_error(env, NULL, "object");
    return NULL;
  }
  if (!int_prop(env, obj, "parentStdin", in[0])
      || !int_prop(env, obj, "childStdin", in[1])
      || !int_prop(env, obj, "stdinProbe", probe)
      || !int_prop(env, obj, "stdoutWriter", writer)
      || !int_prop(env, obj, "childStdout", out[0])
      || !int_prop(env, obj, "parentStdout", out[1])
      || !int_prop(env, obj, "sndbufIn", sndbuf_in)
      || !int_prop(env, obj, "sndbufOut", sndbuf_out)) {
    close_all(in[0], in[1], out[0], out[1], probe, writer);
    napi_throw_error(env, NULL, "object");
    return NULL;
  }
  return obj;
}

static napi_value ioctl_count(napi_env env, napi_callback_info info, unsigned long req) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fd = -1;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "fd");
    return NULL;
  }
  int count = 0;
  if (ioctl(fd, req, &count) != 0 || count < 0) {
    napi_throw_error(env, NULL, "ioctl");
    return NULL;
  }
  napi_value out;
  if (napi_create_int32(env, count, &out) != napi_ok) return NULL;
  return out;
}

static napi_value Pending(napi_env env, napi_callback_info info) {
  return ioctl_count(env, info, FIONREAD);
}

/* TCP SIOCOUTQ is unacknowledged data bytes. Unix SIOCOUTQ is truesize and
   is not a child-stdio term; the mux socket is the TCP caller. */
static napi_value Outq(napi_env env, napi_callback_info info) {
  return ioctl_count(env, info, SIOCOUTQ);
}

static napi_value SetSndbuf(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fd = -1;
  int32_t request = 0;
  if (argc < 2
      || napi_get_value_int32(env, argv[0], &fd) != napi_ok
      || napi_get_value_int32(env, argv[1], &request) != napi_ok
      || fd < 0
      || request <= 0) {
    napi_throw_type_error(env, NULL, "sndbuf");
    return NULL;
  }
  int got = 0;
  if (set_sndbuf(fd, request, &got) != 0) {
    napi_throw_error(env, NULL, "sndbuf");
    return NULL;
  }
  napi_value out;
  if (napi_create_int32(env, got, &out) != napi_ok) return NULL;
  return out;
}

static napi_value GetSndbuf(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fd = -1;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "fd");
    return NULL;
  }
  int got = 0;
  if (read_sndbuf(fd, &got) != 0) {
    napi_throw_error(env, NULL, "sndbuf");
    return NULL;
  }
  napi_value out;
  if (napi_create_int32(env, got, &out) != napi_ok) return NULL;
  return out;
}

static napi_value GetRcvbuf(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fd = -1;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "fd");
    return NULL;
  }
  int got = 0;
  if (read_sockopt(fd, SO_RCVBUF, &got) != 0) {
    napi_throw_error(env, NULL, "rcvbuf");
    return NULL;
  }
  napi_value out;
  if (napi_create_int32(env, got, &out) != napi_ok) return NULL;
  return out;
}

static napi_value one_fd(napi_env env, napi_callback_info info, int32_t *fd) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1 || napi_get_value_int32(env, argv[0], fd) != napi_ok) {
    napi_throw_type_error(env, NULL, "fd");
    return NULL;
  }
  napi_value undef;
  if (napi_get_undefined(env, &undef) != napi_ok) return NULL;
  return undef;
}

/* Listening socket with SO_SNDBUF and SO_RCVBUF pinned before listen.
   The caller listens. The accepted socket inherits this read-back. */
static napi_value PinListen(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t request = 0;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &request) != napi_ok || request <= 0) {
    napi_throw_type_error(env, NULL, "sndbuf");
    return NULL;
  }
  int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    napi_throw_error(env, NULL, "socket");
    return NULL;
  }
  int snd = 0;
  int rcv = 0;
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(0);
  if (set_sockopt(fd, SO_SNDBUF, request, &snd) != 0
      || set_sockopt(fd, SO_RCVBUF, request, &rcv) != 0
      || bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    close_quiet(fd);
    napi_throw_error(env, NULL, "pin");
    return NULL;
  }
  struct sockaddr_in bound;
  socklen_t blen = sizeof(bound);
  if (getsockname(fd, (struct sockaddr *)&bound, &blen) != 0) {
    close_quiet(fd);
    napi_throw_error(env, NULL, "pin");
    return NULL;
  }
  napi_value obj;
  if (napi_create_object(env, &obj) != napi_ok) {
    close_quiet(fd);
    napi_throw_error(env, NULL, "object");
    return NULL;
  }
  if (!int_prop(env, obj, "fd", fd)
      || !int_prop(env, obj, "port", ntohs(bound.sin_port))
      || !int_prop(env, obj, "sndbuf", snd)
      || !int_prop(env, obj, "rcvbuf", rcv)) {
    close_quiet(fd);
    napi_throw_error(env, NULL, "object");
    return NULL;
  }
  return obj;
}

/* Connected socket. Buffers are set before connect, then read back. */
static napi_value ConnectPinned(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t port = 0;
  int32_t request = 0;
  if (argc < 2
      || napi_get_value_int32(env, argv[0], &port) != napi_ok
      || napi_get_value_int32(env, argv[1], &request) != napi_ok
      || port <= 0
      || request <= 0) {
    napi_throw_type_error(env, NULL, "connect");
    return NULL;
  }
  int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) {
    napi_throw_error(env, NULL, "socket");
    return NULL;
  }
  int snd = 0;
  int rcv = 0;
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons((uint16_t)port);
  if (set_sockopt(fd, SO_SNDBUF, request, &snd) != 0
      || set_sockopt(fd, SO_RCVBUF, request, &rcv) != 0
      || connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    close_quiet(fd);
    napi_throw_error(env, NULL, "connect");
    return NULL;
  }
  napi_value obj;
  if (napi_create_object(env, &obj) != napi_ok) {
    close_quiet(fd);
    napi_throw_error(env, NULL, "object");
    return NULL;
  }
  if (!int_prop(env, obj, "fd", fd)
      || !int_prop(env, obj, "sndbuf", snd)
      || !int_prop(env, obj, "rcvbuf", rcv)) {
    close_quiet(fd);
    napi_throw_error(env, NULL, "object");
    return NULL;
  }
  return obj;
}

static napi_value DupFd(napi_env env, napi_callback_info info) {
  int32_t fd = -1;
  if (!one_fd(env, info, &fd) || fd < 0) return NULL;
  int duped = fcntl(fd, F_DUPFD_CLOEXEC, 0);
  if (duped < 0) {
    napi_throw_error(env, NULL, "dup");
    return NULL;
  }
  napi_value out;
  if (napi_create_int32(env, duped, &out) != napi_ok) return NULL;
  return out;
}

static napi_value SetSubreaper(napi_env env, napi_callback_info info) {
  (void)info;
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
    napi_throw_error(env, NULL, "subreaper");
    return NULL;
  }
  napi_value undef;
  if (napi_get_undefined(env, &undef) != napi_ok) return NULL;
  return undef;
}

static napi_value SetGroup(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t pid = -1;
  int32_t pgid = -1;
  if (argc < 2
      || napi_get_value_int32(env, argv[0], &pid) != napi_ok
      || napi_get_value_int32(env, argv[1], &pgid) != napi_ok
      || pid < 0
      || pgid <= 1) {
    napi_throw_type_error(env, NULL, "setpgid");
    return NULL;
  }
  if (setpgid(pid, pgid) != 0) {
    napi_throw_error(env, NULL, "setpgid");
    return NULL;
  }
  napi_value undef;
  if (napi_get_undefined(env, &undef) != napi_ok) return NULL;
  return undef;
}

static napi_value ProcessGroup(napi_env env, napi_callback_info info) {
  int32_t pid = -1;
  if (!one_fd(env, info, &pid) || pid < 0) return NULL;
  pid_t group = getpgid(pid);
  if (group <= 1) {
    napi_throw_error(env, NULL, "getpgid");
    return NULL;
  }
  napi_value out;
  if (napi_create_int32(env, (int32_t)group, &out) != napi_ok) return NULL;
  return out;
}

/* Fork is allowed here: the caller is the supervisor, not a confined plugin.
   The child joins pgid and sleeps. It must not touch the runtime after fork. */
static napi_value SpawnSleeper(napi_env env, napi_callback_info info) {
  int32_t pgid = 0;
  if (!one_fd(env, info, &pgid) || pgid <= 1) return NULL;
  pid_t pid = fork();
  if (pid < 0) {
    napi_throw_error(env, NULL, "fork");
    return NULL;
  }
  if (pid == 0) {
    if (setpgid(0, pgid) != 0) _exit(2);
    for (;;) pause();
  }
  napi_value out;
  if (napi_create_int32(env, (int32_t)pid, &out) != napi_ok) return NULL;
  return out;
}

static napi_value ReapGroup(napi_env env, napi_callback_info info) {
  int32_t pgid = 0;
  if (!one_fd(env, info, &pgid) || pgid <= 1) return NULL;
  int reaped = 0;
  for (;;) {
    int status = 0;
    pid_t got = waitpid(-(pid_t)pgid, &status, WNOHANG);
    if (got > 0) {
      reaped++;
      continue;
    }
    break;
  }
  napi_value out;
  if (napi_create_int32(env, reaped, &out) != napi_ok) return NULL;
  return out;
}

/* Errno of one forbidden call. A success is confinement failure: the child
   of an unexpected fork exits, and the parent reports 0. Refuses to try
   unless this process already has the filter, so a test process cannot fork. */
struct clone_args_min {
  uint64_t flags;
  uint64_t pidfd;
  uint64_t child_tid;
  uint64_t parent_tid;
  uint64_t exit_signal;
  uint64_t stack;
  uint64_t stack_size;
  uint64_t tls;
};

static int call_errno(long nr, long a0, long a1) {
  errno = 0;
  long rc = syscall(nr, a0, a1, 0, 0, 0, 0);
  if (rc < 0) return errno;
  if (rc == 0) _exit(0);
  return 0;
}

static void *thread_ok(void *arg) {
  (void)arg;
  return NULL;
}

/* Positive control: CLONE_THREAD must still succeed under the filter.
   glibc uses clone3 and falls back when the filter returns ENOSYS. */
static int clone_thread_errno(void) {
  pthread_t thread;
  int rc = pthread_create(&thread, NULL, thread_ok, NULL);
  if (rc != 0) return rc;
  if (pthread_join(thread, NULL) != 0) return EAGAIN;
  return 0;
}

static int prop_call(napi_env env, napi_value obj, const char *name, long nr, long a0, long a1) {
  return int_prop(env, obj, name, call_errno(nr, a0, a1)) != NULL;
}

static napi_value ProbeConfinement(napi_env env, napi_callback_info info) {
  (void)info;
  int nnp = prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0);
  int mode = prctl(PR_GET_SECCOMP, 0, 0, 0, 0);
  if (nnp != 1 || mode != SECCOMP_MODE_FILTER) {
    napi_throw_error(env, NULL, "not-confined");
    return NULL;
  }
  napi_value obj;
  if (napi_create_object(env, &obj) != napi_ok) return NULL;
  if (!int_prop(env, obj, "confined", 1)) return NULL;
  if (!int_prop(env, obj, "cloneThread", clone_thread_errno())) return NULL;
#ifdef __NR_fork
  if (!prop_call(env, obj, "fork", __NR_fork, 0, 0)) return NULL;
#endif
#ifdef __NR_vfork
  if (!prop_call(env, obj, "vfork", __NR_vfork, 0, 0)) return NULL;
#endif
#ifdef __NR_clone
  if (!prop_call(env, obj, "clone", __NR_clone, 0, 0)) return NULL;
#endif
#ifdef __NR_clone3
  struct clone_args_min args;
  memset(&args, 0, sizeof(args));
  args.exit_signal = SIGCHLD;
  if (!prop_call(env, obj, "clone3", __NR_clone3, (long)&args, (long)sizeof(args))) return NULL;
#endif
#ifdef __NR_splice
  if (!prop_call(env, obj, "splice", __NR_splice, -1, -1)) return NULL;
#endif
#ifdef __NR_vmsplice
  if (!prop_call(env, obj, "vmsplice", __NR_vmsplice, -1, 0)) return NULL;
#endif
#ifdef __NR_tee
  if (!prop_call(env, obj, "tee", __NR_tee, -1, -1)) return NULL;
#endif
#ifdef __NR_sendfile
  if (!prop_call(env, obj, "sendfile", __NR_sendfile, -1, -1)) return NULL;
#endif
#ifdef __NR_io_uring_setup
  if (!prop_call(env, obj, "io_uring_setup", __NR_io_uring_setup, 1, 0)) return NULL;
#endif
#ifdef __NR_io_uring_enter
  /* IORING_OP_SPLICE is submitted through io_uring_enter. The filter rejects
     the enter, so the opcode never reaches the kernel. */
  if (!prop_call(env, obj, "io_uring_enter", __NR_io_uring_enter, -1, 0)) return NULL;
#endif
#ifdef __NR_io_uring_register
  if (!prop_call(env, obj, "io_uring_register", __NR_io_uring_register, -1, 0)) return NULL;
#endif
#ifdef __NR_pidfd_open
  if (!prop_call(env, obj, "pidfd_open", __NR_pidfd_open, -1, 0)) return NULL;
#endif
#ifdef __NR_pidfd_getfd
  if (!prop_call(env, obj, "pidfd_getfd", __NR_pidfd_getfd, -1, 0)) return NULL;
#endif
#ifdef __NR_ptrace
  if (!prop_call(env, obj, "ptrace", __NR_ptrace, 16, -1)) return NULL;
#endif
#ifdef __NR_process_vm_readv
  if (!prop_call(env, obj, "process_vm_readv", __NR_process_vm_readv, -1, 0)) return NULL;
#endif
#ifdef __NR_process_vm_writev
  if (!prop_call(env, obj, "process_vm_writev", __NR_process_vm_writev, -1, 0)) return NULL;
#endif
#ifdef __NR_kcmp
  if (!prop_call(env, obj, "kcmp", __NR_kcmp, -1, -1)) return NULL;
#endif
  {
    int before = prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
    errno = 0;
    int raised = prctl(PR_SET_DUMPABLE, 1, 0, 0, 0);
    int raisedErrno = raised == 0 ? 0 : errno;
    int after = prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
    if (!int_prop(env, obj, "dumpable", before)) return NULL;
    if (!int_prop(env, obj, "setDumpable", raisedErrno)) return NULL;
    if (!int_prop(env, obj, "dumpableAfter", after)) return NULL;
  }
#ifdef __x86_64__
  /* Same numbers with the x32 bit. EPERM is the filter; ENOSYS would be the
     kernel rejecting an x32 ABI it was built without. */
  if (!prop_call(env, obj, "x32Fork", __NR_fork | __X32_SYSCALL_BIT, 0, 0)) return NULL;
  if (!prop_call(env, obj, "x32Splice", __NR_splice | __X32_SYSCALL_BIT, -1, -1)) return NULL;
#endif
  return obj;
}

struct burst_state {
  int fd;
  int ceiling;
  char path[4096];
  int fork_errno;
  atomic_int written;
  atomic_int crossed;
  atomic_int ready;
  atomic_int go;
  int64_t crossed_ms;
};

static int64_t wall_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_REALTIME, &ts) != 0) return 0;
  return (int64_t)ts.tv_sec * 1000 + (int64_t)ts.tv_nsec / 1000000;
}

static void write_mark(struct burst_state *state, int written, int64_t ms) {
  char line[160];
  int n = snprintf(line, sizeof(line), "threads %lld %d %d\n",
    (long long)ms, written, state->fork_errno);
  if (n <= 0 || n >= (int)sizeof(line)) return;
  int out = open(state->path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (out < 0) return;
  ssize_t put = write(out, line, (size_t)n);
  (void)put;
  close(out);
}

static void *burst_worker(void *arg) {
  struct burst_state *state = arg;
  /* One skb is capped near (sndbuf >> 1) - 64. A single 4096-byte send is
     long enough for that alloc to overlap another thread's wmem check. */
  char buf[4096];
  memset(buf, 'T', sizeof(buf));
  atomic_fetch_add(&state->ready, 1);
  while (atomic_load(&state->go) == 0) {
  }
  ssize_t n = send(state->fd, buf, sizeof(buf), MSG_DONTWAIT);
  if (n > 0) {
    int total = atomic_fetch_add(&state->written, (int)n) + (int)n;
    if (total > state->ceiling) {
      int expected = 0;
      if (atomic_compare_exchange_strong(&state->crossed, &expected, 1)) {
        int64_t ms = wall_ms();
        state->crossed_ms = ms;
        write_mark(state, total, ms);
      }
    }
  }
  return NULL;
}

/* Threads write one stdout fd together. Two skbs fill sndbuf and stay under
   K. Four overlapping sends are what queue a fourth skb. The mark is written
   on the crossing, before the threads return, so a later SIGKILL still leaves
   the clock. */
static napi_value BurstWriters(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fd = -1;
  int32_t ceiling = 0;
  int32_t threads = 4;
  if (argc < 3
      || napi_get_value_int32(env, argv[0], &fd) != napi_ok
      || napi_get_value_int32(env, argv[1], &ceiling) != napi_ok
      || fd < 0
      || ceiling <= 0
      || (argc >= 4 && napi_get_value_int32(env, argv[3], &threads) != napi_ok)
      || threads < 2
      || threads > 32) {
    napi_throw_type_error(env, NULL, "burst");
    return NULL;
  }
  struct burst_state state;
  memset(&state, 0, sizeof(state));
  state.fd = fd;
  state.ceiling = ceiling;
  state.fork_errno = -1;
  size_t path_len = 0;
  if (napi_get_value_string_utf8(env, argv[2], state.path, sizeof(state.path), &path_len) != napi_ok
      || path_len == 0) {
    napi_throw_type_error(env, NULL, "mark");
    return NULL;
  }
  int nnp = prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0);
  int mode = prctl(PR_GET_SECCOMP, 0, 0, 0, 0);
  if (nnp == 1 && mode == SECCOMP_MODE_FILTER) {
#ifdef __NR_fork
    state.fork_errno = call_errno(__NR_fork, 0, 0);
#endif
  }
  atomic_init(&state.written, 0);
  atomic_init(&state.crossed, 0);
  atomic_init(&state.ready, 0);
  atomic_init(&state.go, 0);
  pthread_t ids[32];
  int started = 0;
  long cpus = sysconf(_SC_NPROCESSORS_ONLN);
  if (cpus < 1) cpus = 1;
  for (int i = 0; i < threads; i++) {
    if (pthread_create(&ids[i], NULL, burst_worker, &state) != 0) {
      atomic_store(&state.go, 1);
      for (int j = 0; j < started; j++) pthread_join(ids[j], NULL);
      napi_throw_error(env, NULL, "thread");
      return NULL;
    }
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET((int)(i % cpus), &set);
    pthread_setaffinity_np(ids[i], sizeof(set), &set);
    started++;
  }
  while (atomic_load(&state.ready) < threads) {
  }
  atomic_store(&state.go, 1);
  for (int i = 0; i < started; i++) pthread_join(ids[i], NULL);
  napi_value obj;
  if (napi_create_object(env, &obj) != napi_ok) return NULL;
  int written = atomic_load(&state.written);
  int crossed = atomic_load(&state.crossed);
  if (!int_prop(env, obj, "written", written)) return NULL;
  if (!int_prop(env, obj, "crossed", crossed)) return NULL;
  if (!int_prop(env, obj, "fork", state.fork_errno)) return NULL;
  napi_value at;
  if (napi_create_double(env, (double)state.crossed_ms, &at) != napi_ok) return NULL;
  if (napi_set_named_property(env, obj, "crossedAt", at) != napi_ok) return NULL;
  return obj;
}

static napi_value SetDumpable(napi_env env, napi_callback_info info) {
  (void)info;
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    napi_throw_error(env, NULL, "dumpable");
    return NULL;
  }
  napi_value undef;
  if (napi_get_undefined(env, &undef) != napi_ok) return NULL;
  return undef;
}

static napi_value GetDumpable(napi_env env, napi_callback_info info) {
  (void)info;
  int value = prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
  if (value < 0) {
    napi_throw_error(env, NULL, "dumpable");
    return NULL;
  }
  napi_value out;
  if (napi_create_int32(env, value, &out) != napi_ok) return NULL;
  return out;
}

/* Copy a private regular file into a sealed memfd. The seal sticks to the
   inode, so a later replace of the cache path cannot change the bytes the
   supervisor executes. The fd stays CLOEXEC in this process; spawn dup2s it
   onto the child. */
static napi_value SealFile(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char path[4096];
  size_t len = 0;
  if (argc < 1
      || napi_get_value_string_utf8(env, argv[0], path, sizeof(path), &len) != napi_ok
      || len == 0
      || len >= sizeof(path) - 1) {
    napi_throw_type_error(env, NULL, "path");
    return NULL;
  }
  int src = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (src < 0) {
    napi_throw_error(env, NULL, "open");
    return NULL;
  }
  struct stat st;
  if (fstat(src, &st) != 0
      || !S_ISREG(st.st_mode)
      || st.st_uid != getuid()
      || (st.st_mode & 077) != 0
      || st.st_size <= 0
      || st.st_size > 8 * 1024 * 1024) {
    close(src);
    napi_throw_error(env, NULL, "stat");
    return NULL;
  }
  int mem = memfd_create("plerni", MFD_CLOEXEC | MFD_ALLOW_SEALING);
  if (mem < 0) {
    close(src);
    napi_throw_error(env, NULL, "memfd");
    return NULL;
  }
  char buf[8192];
  for (;;) {
    ssize_t n = read(src, buf, sizeof(buf));
    if (n < 0) {
      if (errno == EINTR) continue;
      close(src);
      close(mem);
      napi_throw_error(env, NULL, "read");
      return NULL;
    }
    if (n == 0) break;
    ssize_t off = 0;
    while (off < n) {
      ssize_t w = write(mem, buf + off, (size_t)(n - off));
      if (w < 0) {
        if (errno == EINTR) continue;
        close(src);
        close(mem);
        napi_throw_error(env, NULL, "write");
        return NULL;
      }
      off += w;
    }
  }
  close(src);
  if (lseek(mem, 0, SEEK_SET) != 0
      || fcntl(mem, F_ADD_SEALS, F_SEAL_WRITE | F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_SEAL) != 0) {
    close(mem);
    napi_throw_error(env, NULL, "seal");
    return NULL;
  }
  napi_value out;
  if (napi_create_int32(env, mem, &out) != napi_ok) return NULL;
  return out;
}

static napi_value FileSeals(napi_env env, napi_callback_info info) {
  int32_t fd = -1;
  if (!one_fd(env, info, &fd) || fd < 0) return NULL;
  int seals = fcntl(fd, F_GET_SEALS);
  if (seals < 0) {
    napi_throw_error(env, NULL, "seals");
    return NULL;
  }
  napi_value out;
  if (napi_create_int32(env, seals, &out) != napi_ok) return NULL;
  return out;
}

static void export_fn(napi_env env, napi_value exports, const char *name, napi_callback cb) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn);
  napi_set_named_property(env, exports, name, fn);
}

NAPI_MODULE_INIT() {
  export_fn(env, exports, "create", Create);
  export_fn(env, exports, "pending", Pending);
  export_fn(env, exports, "outq", Outq);
  export_fn(env, exports, "setSndbuf", SetSndbuf);
  export_fn(env, exports, "sndbuf", GetSndbuf);
  export_fn(env, exports, "rcvbuf", GetRcvbuf);
  export_fn(env, exports, "pinListen", PinListen);
  export_fn(env, exports, "connectPinned", ConnectPinned);
  export_fn(env, exports, "dupFd", DupFd);
  export_fn(env, exports, "setSubreaper", SetSubreaper);
  export_fn(env, exports, "setDumpable", SetDumpable);
  export_fn(env, exports, "dumpable", GetDumpable);
  export_fn(env, exports, "setGroup", SetGroup);
  export_fn(env, exports, "processGroup", ProcessGroup);
  export_fn(env, exports, "reapGroup", ReapGroup);
  export_fn(env, exports, "spawnSleeper", SpawnSleeper);
  export_fn(env, exports, "probeConfinement", ProbeConfinement);
  export_fn(env, exports, "burstWriters", BurstWriters);
  export_fn(env, exports, "sealFile", SealFile);
  export_fn(env, exports, "fileSeals", FileSeals);
  return exports;
}
