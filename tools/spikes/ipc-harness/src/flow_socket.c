#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

/* Child stdio ends for the flow-control reservation.
   socketpair, SO_SNDBUF on each writer, a dup of the stdin read end for
   FIONREAD, and shutdown of the unused direction. SIOCOUTQ is not read:
   on AF_UNIX it counts skb truesize, not payload bytes. */

static void close_quiet(int fd) {
  if (fd >= 0) close(fd);
}

static void close_all(int in0, int in1, int out0, int out1, int probe) {
  close_quiet(in0);
  close_quiet(in1);
  close_quiet(out0);
  close_quiet(out1);
  close_quiet(probe);
}

static int set_sndbuf(int fd, int request, int *got) {
  if (setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &request, sizeof(request)) != 0) return -1;
  int value = 0;
  socklen_t len = sizeof(value);
  if (getsockopt(fd, SOL_SOCKET, SO_SNDBUF, &value, &len) != 0 || value <= 0) return -1;
  *got = value;
  return 0;
}

static int read_sndbuf(int fd, int *got) {
  int value = 0;
  socklen_t len = sizeof(value);
  if (getsockopt(fd, SOL_SOCKET, SO_SNDBUF, &value, &len) != 0 || value <= 0) return -1;
  *got = value;
  return 0;
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
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, in) != 0) {
    napi_throw_error(env, NULL, "socketpair");
    return NULL;
  }
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, out) != 0) {
    close_all(in[0], in[1], -1, -1, -1);
    napi_throw_error(env, NULL, "socketpair");
    return NULL;
  }
  /* in[0] is the parent's stdin writer. out[0] is the child's stdout writer. */
  int sndbuf_out = 0;
  int sndbuf_in = 0;
  if (set_sndbuf(in[0], request, &sndbuf_out) != 0 || set_sndbuf(out[0], request, &sndbuf_in) != 0) {
    close_all(in[0], in[1], out[0], out[1], -1);
    napi_throw_error(env, NULL, "sndbuf");
    return NULL;
  }
  probe = dup(in[1]);
  if (probe < 0 || fcntl(probe, F_SETFD, FD_CLOEXEC) != 0) {
    close_all(in[0], in[1], out[0], out[1], probe);
    napi_throw_error(env, NULL, "dup");
    return NULL;
  }
  /* The child inherits in[1] as fd 0 and out[0] as fd 1. Shut the directions
     it must not use. shutdown is not reversible. */
  if (shutdown(in[1], SHUT_WR) != 0 || shutdown(out[0], SHUT_RD) != 0) {
    close_all(in[0], in[1], out[0], out[1], probe);
    napi_throw_error(env, NULL, "shutdown");
    return NULL;
  }
  napi_value obj;
  if (napi_create_object(env, &obj) != napi_ok) {
    close_all(in[0], in[1], out[0], out[1], probe);
    napi_throw_error(env, NULL, "object");
    return NULL;
  }
  if (!int_prop(env, obj, "parentStdin", in[0])
      || !int_prop(env, obj, "childStdin", in[1])
      || !int_prop(env, obj, "stdinProbe", probe)
      || !int_prop(env, obj, "childStdout", out[0])
      || !int_prop(env, obj, "parentStdout", out[1])
      || !int_prop(env, obj, "sndbufIn", sndbuf_in)
      || !int_prop(env, obj, "sndbufOut", sndbuf_out)) {
    close_all(in[0], in[1], out[0], out[1], probe);
    napi_throw_error(env, NULL, "object");
    return NULL;
  }
  return obj;
}

static napi_value Pending(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fd = -1;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "fd");
    return NULL;
  }
  int unread = 0;
  if (ioctl(fd, FIONREAD, &unread) != 0 || unread < 0) {
    napi_throw_error(env, NULL, "ioctl");
    return NULL;
  }
  napi_value out;
  if (napi_create_int32(env, unread, &out) != napi_ok) return NULL;
  return out;
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

NAPI_MODULE_INIT() {
  napi_value create_fn;
  napi_value pending_fn;
  napi_value set_fn;
  napi_value get_fn;
  napi_create_function(env, "create", NAPI_AUTO_LENGTH, Create, NULL, &create_fn);
  napi_create_function(env, "pending", NAPI_AUTO_LENGTH, Pending, NULL, &pending_fn);
  napi_create_function(env, "setSndbuf", NAPI_AUTO_LENGTH, SetSndbuf, NULL, &set_fn);
  napi_create_function(env, "sndbuf", NAPI_AUTO_LENGTH, GetSndbuf, NULL, &get_fn);
  napi_set_named_property(env, exports, "create", create_fn);
  napi_set_named_property(env, exports, "pending", pending_fn);
  napi_set_named_property(env, exports, "setSndbuf", set_fn);
  napi_set_named_property(env, exports, "sndbuf", get_fn);
  return exports;
}
