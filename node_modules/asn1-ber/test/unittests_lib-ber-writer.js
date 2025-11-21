
var asn1 = require("../")
var assert = require("assert")

var BerWriter = asn1.BerWriter

describe("lib/ber/writer.js", function() {
	describe("writeByte()", function() {
		it("can write a value", function() {
			var writer = new BerWriter()
			writer.writeByte(0xC2)

			var buffer = writer.buffer

			assert.equal(buffer.length, 1)
			assert.equal(buffer[0], 0xc2)
		})
	})

	describe("writeInt()", function() {
		it("can write zero", function() {
			var writer = new BerWriter()
			writer.writeInt(0)

			var buffer = writer.buffer

			assert.equal(buffer.length, 3)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x01)
			assert.equal(buffer[2], 0x00)
		})

		it("can write 1 byte positive integers - lowest", function() {
			var writer = new BerWriter()
			writer.writeInt(1)

			var buffer = writer.buffer

			assert.equal(buffer.length, 3)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x01)
			assert.equal(buffer[2], 0x01)
		})

		it("can write 1 byte positive integers - middle", function() {
			var writer = new BerWriter()
			writer.writeInt(101)

			var buffer = writer.buffer

			assert.equal(buffer.length, 3)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x01)
			assert.equal(buffer[2], 0x65)
		})

		it("can write 1 byte positive integers - highest", function() {
			var writer = new BerWriter()
			writer.writeInt(127)

			var buffer = writer.buffer

			assert.equal(buffer.length, 3)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x01)
			assert.equal(buffer[2], 0x7f)
		})

		it("can write 2 byte positive integers - lowest", function() {
			var writer = new BerWriter()
			writer.writeInt(128)

			var buffer = writer.buffer

			assert.equal(buffer.length, 4)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x02)
			assert.equal(buffer[2], 0x00)
			assert.equal(buffer[3], 0x80)
		})

		it("can write 2 byte positive integers - middle", function() {
			var writer = new BerWriter()
			writer.writeInt(9374)

			var buffer = writer.buffer

			assert.equal(buffer.length, 4)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x02)
			assert.equal(buffer[2], 0x24)
			assert.equal(buffer[3], 0x9e)
		})

		it("can write 2 byte positive integers - highest", function() {
			var writer = new BerWriter()
			writer.writeInt(32767)

			var buffer = writer.buffer

			assert.equal(buffer.length, 4)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x02)
			assert.equal(buffer[2], 0x7f)
			assert.equal(buffer[3], 0xff)
		})

		it("can write 3 byte positive integers - lowest", function() {
			var writer = new BerWriter()
			writer.writeInt(32768)

			var buffer = writer.buffer

			assert.equal(buffer.length, 5)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x03)
			assert.equal(buffer[2], 0x00)
			assert.equal(buffer[3], 0x80)
			assert.equal(buffer[4], 0x00)
		})

		it("can write 3 byte positive integers - middle", function() {
			var writer = new BerWriter()
			writer.writeInt(5938243)

			var buffer = writer.buffer

			assert.equal(buffer.length, 5)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x03)
			assert.equal(buffer[2], 0x5a)
			assert.equal(buffer[3], 0x9c)
			assert.equal(buffer[4], 0x43)
		})

		it("can write 3 byte positive integers - highest", function() {
			var writer = new BerWriter()
			writer.writeInt(8388607)

			var buffer = writer.buffer

			assert.equal(buffer.length, 5)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x03)
			assert.equal(buffer[2], 0x7f)
			assert.equal(buffer[3], 0xff)
			assert.equal(buffer[4], 0xff)
		})

		it("can write 4 byte positive integers - lowest", function() {
			var writer = new BerWriter()
			writer.writeInt(8388608)

			var buffer = writer.buffer

			assert.equal(buffer.length, 6)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x04)
			assert.equal(buffer[2], 0x00)
			assert.equal(buffer[3], 0x80)
			assert.equal(buffer[4], 0x00)
			assert.equal(buffer[5], 0x00)
		})

		it("can write 4 byte positive integers - middle", function() {
			var writer = new BerWriter()
			writer.writeInt(1483722690)

			var buffer = writer.buffer

			assert.equal(buffer.length, 6)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x04)
			assert.equal(buffer[2], 0x58)
			assert.equal(buffer[3], 0x6f)
			assert.equal(buffer[4], 0xcf)
			assert.equal(buffer[5], 0xc2)
		})

		it("can write 4 byte positive integers - highest", function() {
			var writer = new BerWriter()
			writer.writeInt(2147483647)

			var buffer = writer.buffer

			assert.equal(buffer.length, 6)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x04)
			assert.equal(buffer[2], 0x7f)
			assert.equal(buffer[3], 0xff)
			assert.equal(buffer[4], 0xff)
			assert.equal(buffer[5], 0xff)
		})

		it("can write 5 byte positive integers - lowest", function() {
			var writer = new BerWriter()
			writer.writeInt(2147483648)

			var buffer = writer.buffer

			assert.equal(buffer.length, 7)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x05)
			assert.equal(buffer[2], 0x00)
			assert.equal(buffer[3], 0x80)
			assert.equal(buffer[4], 0x00)
			assert.equal(buffer[5], 0x00)
			assert.equal(buffer[6], 0x00)
		})

		it("can write 5 byte positive integers - middle", function() {
			var writer = new BerWriter()
			writer.writeInt(3843548325)

			var buffer = writer.buffer

			assert.equal(buffer.length, 7)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x05)
			assert.equal(buffer[2], 0x00)
			assert.equal(buffer[3], 0xe5)
			assert.equal(buffer[4], 0x17)
			assert.equal(buffer[5], 0xe4)
			assert.equal(buffer[6], 0xa5)
		})

		it("can write 5 byte positive integers - highest", function() {
			var writer = new BerWriter()
			writer.writeInt(4294967295)

			var buffer = writer.buffer

			assert.equal(buffer.length, 7)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x05)
			assert.equal(buffer[2], 0x00)
			assert.equal(buffer[3], 0xff)
			assert.equal(buffer[4], 0xff)
			assert.equal(buffer[5], 0xff)
			assert.equal(buffer[6], 0xff)
		})

		it("can write 1 byte negative integers - lowest", function() {
			var writer = new BerWriter()
			writer.writeInt(-128)

			var buffer = writer.buffer

			assert.equal(buffer.length, 3)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x01)
			assert.equal(buffer[2], 0x80)
		})

		it("can write 1 byte negative integers - middle", function() {
			var writer = new BerWriter()
			writer.writeInt(-73)

			var buffer = writer.buffer

			assert.equal(buffer.length, 3)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x01)
			assert.equal(buffer[2], 0xb7)
		})

		it("can write 1 byte negative integers - highest", function() {
			var writer = new BerWriter()
			writer.writeInt(-1)

			var buffer = writer.buffer

			assert.equal(buffer.length, 3)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x01)
			assert.equal(buffer[2], 0xff)
		})

		it("can write 2 byte negative integers - lowest", function() {
			var writer = new BerWriter()
			writer.writeInt(-32768)

			var buffer = writer.buffer

			assert.equal(buffer.length, 4)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x02)
			assert.equal(buffer[2], 0x80)
			assert.equal(buffer[3], 0x00)
		})

		it("can write 2 byte negative integers - middle", function() {
			var writer = new BerWriter()
			writer.writeInt(-22400)

			var buffer = writer.buffer

			assert.equal(buffer.length, 4)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x02)
			assert.equal(buffer[2], 0xa8)
			assert.equal(buffer[3], 0x80)
		})

		it("can write 2 byte negative integers - highest", function() {
			var writer = new BerWriter()
			writer.writeInt(-129)

			var buffer = writer.buffer

			assert.equal(buffer.length, 4)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x02)
			assert.equal(buffer[2], 0xff)
			assert.equal(buffer[3], 0x7f)
		})

		it("can write 3 byte negative integers - lowest", function() {
			var writer = new BerWriter()
			writer.writeInt(-8388608)

			var buffer = writer.buffer

			assert.equal(buffer.length, 5)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x03)
			assert.equal(buffer[2], 0x80)
			assert.equal(buffer[3], 0x00)
			assert.equal(buffer[4], 0x00)
		})

		it("can write 3 byte negative integers - middle", function() {
			var writer = new BerWriter()
			writer.writeInt(-481653)

			var buffer = writer.buffer

			assert.equal(buffer.length, 5)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x03)
			assert.equal(buffer[2], 0xf8)
			assert.equal(buffer[3], 0xa6)
			assert.equal(buffer[4], 0x8b)
		})

		it("can write 3 byte negative integers - highest", function() {
			var writer = new BerWriter()
			writer.writeInt(-32769)

			var buffer = writer.buffer

			assert.equal(buffer.length, 5)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x03)
			assert.equal(buffer[2], 0xff)
			assert.equal(buffer[3], 0x7f)
			assert.equal(buffer[4], 0xff)
		})

		it("can write 4 byte negative integers - lowest", function() {
			var writer = new BerWriter()
			writer.writeInt(-2147483648)

			var buffer = writer.buffer

			assert.equal(buffer.length, 6)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x04)
			assert.equal(buffer[2], 0x80)
			assert.equal(buffer[3], 0x00)
			assert.equal(buffer[4], 0x00)
			assert.equal(buffer[5], 0x00)
		})

		it("can write 4 byte negative integers - middle", function() {
			var writer = new BerWriter()
			writer.writeInt(-1522904131)

			var buffer = writer.buffer

			assert.equal(buffer.length, 6)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x04)
			assert.equal(buffer[2], 0xa5)
			assert.equal(buffer[3], 0x3a)
			assert.equal(buffer[4], 0x53)
			assert.equal(buffer[5], 0xbd)
		})

		it("can write 4 byte negative integers - highest", function() {
			var writer = new BerWriter()
			writer.writeInt(-8388609)

			var buffer = writer.buffer

			assert.equal(buffer.length, 6)
			assert.equal(buffer[0], 0x02)
			assert.equal(buffer[1], 0x04)
			assert.equal(buffer[2], 0xff)
			assert.equal(buffer[3], 0x7f)
			assert.equal(buffer[4], 0xff)
			assert.equal(buffer[5], 0xff)
		})
	})

	describe("writeBoolean()", function() {
		it("can write a true and false value", function() {
			var writer = new BerWriter()
			writer.writeBoolean(true)
			writer.writeBoolean(false)

			var buffer = writer.buffer

			assert.equal(buffer.length, 6)
			assert.equal(buffer[0], 0x01)
			assert.equal(buffer[1], 0x01)
			assert.equal(buffer[2], 0xff)
			assert.equal(buffer[3], 0x01)
			assert.equal(buffer[4], 0x01)
			assert.equal(buffer[5], 0x00)
		})
	})

	describe("writeString()", function() {
		it("can write a value", function() {
			var writer = new BerWriter()
			writer.writeString("hello world")

			var buffer = writer.buffer

			assert.equal(buffer.length, 13)
			assert.equal(buffer[0], 0x04)
			assert.equal(buffer[1], 11)
			assert.equal(buffer.slice(2).toString("utf8"), "hello world")
		})
	})

	describe("writeBuffer()", function() {
		it("can write a value", function() {
			var writer = new BerWriter()
			writer.writeString("hello world")

			var expected = Buffer.from([
					0x04, 0x0b, 0x30, 0x09, 0x02, 0x01, 0x0f, 0x01,
					0x01, 0xff, 0x01, 0x01, 0xff
				])
			writer.writeBuffer(expected.slice(2, expected.length), 0x04)
			
			buffer = writer.buffer;

			assert.equal(buffer.length, 26)
			assert.equal(buffer[0], 0x04)
			assert.equal(buffer[1], 11)
			assert.equal(buffer.slice(2, 13).toString("utf8"), "hello world")
			assert.equal(buffer[13], expected[0])
			assert.equal(buffer[14], expected[1])

			for (var i = 13, j = 0; i < buffer.length && j < expected.length; i++, j++)
				assert.equal(buffer[i], expected[j])
		})
	})

	describe("writeStringArray()", function() {
		it("can write an array of strings", function() {
			var writer = new BerWriter()
			writer.writeStringArray(["hello world", "fubar!"])

			var buffer = writer.buffer

			assert.equal(buffer.length, 21)
			assert.equal(buffer[0], 0x04)
			assert.equal(buffer[1], 11)
			assert.equal(buffer.slice(2, 13).toString("utf8"), "hello world")

			assert.equal(buffer[13], 0x04)
			assert.equal(buffer[14], 6)
			assert.equal(buffer.slice(15).toString("utf8"), "fubar!")
		})
	})

	describe("oversized data", function() {
		it("results in a buffer resize", function() {
			var writer = new BerWriter({size: 2})
			writer.writeString("hello world")

			var buffer = writer.buffer

			assert.equal(buffer.length, 13)
			assert.equal(buffer[0], 0x04)
			assert.equal(buffer[1], 11)
			assert.equal(buffer.slice(2).toString("utf8"), "hello world")
		})
	})

	describe("complex sequences", function() {
		it("are processed correctly", function() {
			var writer = new BerWriter({size: 25})
			writer.startSequence()
			writer.writeString("hello world")
			writer.endSequence()

			var buffer = writer.buffer

			assert.equal(buffer.length, 15)
			assert.equal(buffer[0], 0x30)
			assert.equal(buffer[1], 13)
			assert.equal(buffer[2], 0x04)
			assert.equal(buffer[3], 11)
			assert.equal(buffer.slice(4).toString("utf8"), "hello world")
		})
	})

	describe("nested sequences", function() {
		it("are processed correctly", function() {
			var writer = new BerWriter({size: 25})
			writer.startSequence()
			writer.writeString("hello world")
			writer.startSequence()
			writer.writeString("hello world")
			writer.endSequence()
			writer.endSequence()

			var buffer = writer.buffer

			assert.equal(buffer.length, 30)
			assert.equal(buffer[0], 0x30)
			assert.equal(buffer[1], 28)
			assert.equal(buffer[2], 0x04)
			assert.equal(buffer[3], 11)
			assert.equal(buffer.slice(4, 15).toString("utf8"), "hello world")

			assert.equal(buffer[15], 0x30)
			assert.equal(buffer[16], 13)
			assert.equal(buffer[17], 0x04)
			assert.equal(buffer[18], 11)
			assert.equal(buffer.slice(19, 30).toString("utf8"), "hello world")
		})
	})

	describe("multiple sequences", function() {
		it("are processed correctly", function() {
			// An anonymous LDAP v3 BIND request
			var dn = "cn=foo,ou=unit,o=test"

			var writer = new BerWriter()
			writer.startSequence()
			writer.writeInt(3)
			writer.startSequence(0x60)
			writer.writeInt(3)
			writer.writeString(dn)
			writer.writeByte(0x80)
			writer.writeByte(0x00)
			writer.endSequence()
			writer.endSequence()

			var buffer = writer.buffer

			assert.equal(buffer.length, 35)
			assert.equal(buffer[0], 0x30)
			assert.equal(buffer[1], 33)
			assert.equal(buffer[2], 0x02)
			assert.equal(buffer[3], 1)
			assert.equal(buffer[4], 0x03)
			assert.equal(buffer[5], 0x60)
			assert.equal(buffer[6], 28)
			assert.equal(buffer[7], 0x02)
			assert.equal(buffer[8], 1)
			assert.equal(buffer[9], 0x03)
			assert.equal(buffer[10], 0x04)
			assert.equal(buffer[11], dn.length)
			assert.equal(buffer.slice(12, 33).toString("utf8"), dn)
			assert.equal(buffer[33], 0x80)
			assert.equal(buffer[34], 0x00)
		})
	})

	describe("writeOID()", function() {
		it("can write a value", function() {
			var writer = new BerWriter()
			writer.writeOID("1.2.840.113549.1.1.1")

			var buffer = writer.buffer

			assert.equal(buffer.toString("hex"), "06092a864886f70d010101")
		})
	})
})
