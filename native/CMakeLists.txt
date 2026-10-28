cmake_minimum_required(VERSION 3.16)
project(lk_native CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(ORT_DIR ${CMAKE_CURRENT_SOURCE_DIR}/vendor/onnxruntime)

add_executable(paradee_server paradee_server.cpp)
target_include_directories(paradee_server PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/vendor
    ${ORT_DIR}/include)
target_link_directories(paradee_server PRIVATE ${ORT_DIR}/lib)
target_link_libraries(paradee_server PRIVATE onnxruntime pthread)
set_target_properties(paradee_server PROPERTIES BUILD_RPATH "\$ORIGIN/../vendor/onnxruntime/lib")
